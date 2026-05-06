require('dotenv').config();
const mqtt = require("mqtt");
const { createClient } = require('@supabase/supabase-js');
const express = require("express");
const path = require("path");
const cors = require("cors");
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- 🔹 CONFIGURACIÓN SUPABASE ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    realtime: {
        params: {
            eventsPerSecond: 10,
        },
    },
});

// --- 🔹 CONFIGURACIÓN NODEMAILER ---
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // false para puerto 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- 📡 MQTT: CONEXIÓN ROBUSTA PARA RENDER ---
const mqttClient = mqtt.connect("mqtts://e46fb974d55a4c96a5bd632a3617db64.s1.eu.hivemq.cloud:8883", {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    keepalive: 60,
    reconnectPeriod: 1000,
    rejectUnauthorized: false // Necesario para algunos entornos gratuitos
});

mqttClient.on("connect", () => {
    console.log("✅ Conectado a HiveMQ Cloud desde Render");
    mqttClient.subscribe("jhosimar/rtc", (err) => {
        if (!err) console.log("📡 Suscrito al tópico de entrada: jhosimar/rtc");
    });
});

mqttClient.on("error", (err) => {
    console.error("❌ Error en MQTT:", err);
});

// --- 🔥 REALTIME: ESCUCHAR CAMBIOS EN SUPABASE Y REENVIAR AL ESP32 AUTOMÁTICAMENTE ---
// Esto resuelve el problema de que el ESP32 no recibe si editas en la DB
// Variable para guardar el último mensaje enviado y evitar ecos
let ultimoMensajeEnviado = "";

supabase
    .channel('cambios-db')
    .on('postgres_changes', 
        { event: 'UPDATE', schema: 'public', table: 'estado_incubadora' }, 
        (payload) => {
            const data = payload.new;
            const mensajeMQTT = JSON.stringify({
                id: data.id_incubadora,
                estado: data.estado,
                set_temp: data.set_temp,
                set_hum: data.set_hum,
                set_dias: data.set_dias,
                set_rot: data.set_rot
            });

            // --- BLOQUEO DE BUCLE ---
            // Si el mensaje es idéntico al anterior, lo ignoramos
            if (mensajeMQTT === ultimoMensajeEnviado) {
                return; 
            }

            if (mqttClient.connected) {
                ultimoMensajeEnviado = mensajeMQTT; // Registramos lo que enviamos
                mqttClient.publish("jhosimar/config", mensajeMQTT);
                console.log("📤 Sincronización única enviada al ESP32");
                
                // Limpiamos el registro después de 5 segundos para permitir cambios legítimos
                setTimeout(() => { ultimoMensajeEnviado = ""; }, 5000);
            }
        }
    )
    .subscribe();

// --- 📩 RECEPCIÓN DE DATOS DESDE EL ESP32 ---
mqttClient.on("message", async (topic, message) => {
    if (topic === "jhosimar/rtc") {
        try {
            const data = JSON.parse(message.toString());
            console.log("📩 Datos recibidos del ESP32:", data);

            const { data: existe } = await supabase
                .from('incubadoras')
                .select('id_incubadora')
                .eq('id_incubadora', data.id)
                .maybeSingle();
            
            if (!existe) return console.log(`🚫 ID ${data.id} no autorizado.`);

            if (data.tipo === "ESTADO") {
                await supabase.from('estado_incubadora').upsert({
                    id_incubadora: data.id,
                    estado: data.estado,
                    set_temp: data.set_temp,
                    set_hum: data.set_hum,
                    set_dias: data.set_dias,
                    set_rot: data.set_rot,
                    fecha_inicio: data.inicio_inc 
                });
            } else {
                await supabase.from('datos_incubadora').insert({
                    id_incubadora: data.id,
                    temperatura: data.temp,
                    humedad: data.hum
                });
            }
        } catch (err) { console.error("❌ Error procesando mensaje MQTT:", err.message); }
    }
});

// --- ⏰ MONITOREO DE ALERTAS ---
async function sistemaDeAlertas() {
    try {
        const { data: incubadoras } = await supabase
            .from('estado_incubadora')
            .select('*')
            .eq('estado', 'Activa');

        if (!incubadoras) return;

        for (let r of incubadoras) {
            const { data: lecturas } = await supabase
                .from('datos_incubadora')
                .select('temperatura, humedad, fecha_hora')
                .eq('id_incubadora', r.id_incubadora)
                .order('fecha_hora', { ascending: false })
                .limit(1);

            const d = lecturas?.[0];
            if (!d) continue;

            const diferenciaMinutos = (new Date() - new Date(d.fecha_hora)) / 60000;
            let alertMsg = "";

            if (diferenciaMinutos > 15) {
                alertMsg = `🚨 <b>CONEXIÓN PERDIDA:</b> La incubadora ${r.id_incubadora} lleva 15 min sin reportar.`;
            } else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `🌡️ <b>ALERTA TEMPERATURA:</b> ${d.temperatura.toFixed(1)}°C (Esperado: ${r.set_temp}°C)`;
            }

            if (alertMsg) {
                console.log(`⚠️ Intentando enviar alerta para ${r.id_incubadora}...`);
                const { data: user } = await supabase.from('usuarios').select('email').eq('id_incubadora', r.id_incubadora).maybeSingle();
                
                if (user?.email) {
                    console.log(`📧 Enviando correo a: ${user.email}`);
                    await transporter.sendMail({
                        // ... tu config de mail
                    });
                    console.log("✅ Correo enviado exitosamente");
                } else {
                    console.log("🚫 No se encontró un correo asociado a este ID de incubadora");
                }
            }
        }
    } catch (err) { console.error("❌ Error Alertas:", err.message); }
}
cron.schedule('* * * * *', sistemaDeAlertas);

// --- 🌐 RUTAS API ---
app.post("/login", async (req, res) => {
    const { usuario, contrasena } = req.body;
    const { data } = await supabase.from('usuarios').select('*').eq('usuario', usuario).eq('contrasena', contrasena).maybeSingle();
    if (!data) return res.status(401).send("Credenciales inválidas");
    res.json(data);
});

app.post("/actualizar-config", async (req, res) => {
    const data = req.body;

    // 1. Preparamos el JSON exacto que espera tu ESP32
    const mensajeMQTT = JSON.stringify({
        id: data.id,
        estado: data.estado,
        set_temp: data.set_temp,
        set_hum: data.set_hum,
        set_dias: data.set_dias,
        set_rot: data.set_rot
    });

    // 2. Verificamos si el servidor de Render está conectado a HiveMQ
    if (mqttClient.connected) {
        try {
            // Enviamos el mensaje al tópico de configuración
            mqttClient.publish("jhosimar/config", mensajeMQTT, { qos: 1 }, (err) => {
                if (err) {
                    console.error("❌ Error al publicar en MQTT:", err);
                    return res.status(500).send("Error al enviar comando al ESP32");
                }
                
                console.log("🚀 Instrucción enviada directo al ESP32:", mensajeMQTT);
                res.send("✅ Comando enviado. Esperando confirmación del dispositivo...");
            });
        } catch (error) {
            console.error("❌ Error interno:", error);
            res.status(500).send("Error interno del servidor");
        }
    } else {
        // 3. Si el broker MQTT está caído o desconectado
        console.error("⚠️ No hay conexión con HiveMQ");
        res.status(503).send("El servicio de mensajería no está disponible. Intenta de nuevo.");
    }
});


app.get("/ping", (req, res) => res.send("pong")); // Para evitar que Render se duerma

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor activo en puerto " + PORT));
