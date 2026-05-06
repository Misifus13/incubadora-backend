require('dotenv').config();
const mqtt = require("mqtt");
const { createClient } = require('@supabase/supabase-js');
const express = require("express");
const path = require("path");
const cors = require("cors");
const { Resend } = require('resend'); // 🔹 Cambio aquí
const cron = require('node-cron');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY); // 🔹 Inicialización de Resend

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

// --- 📡 MQTT: CONEXIÓN ROBUSTA PARA RENDER ---
const mqttClient = mqtt.connect("mqtts://e46fb974d55a4c96a5bd632a3617db64.s1.eu.hivemq.cloud:8883", {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    keepalive: 60,
    reconnectPeriod: 1000,
    rejectUnauthorized: false 
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

// --- 🔥 REALTIME: ESCUCHAR CAMBIOS EN SUPABASE ---
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

            if (mensajeMQTT === ultimoMensajeEnviado) {
                return; 
            }

            if (mqttClient.connected) {
                ultimoMensajeEnviado = mensajeMQTT; 
                mqttClient.publish("jhosimar/config", mensajeMQTT);
                console.log("📤 Sincronización única enviada al ESP32");
                
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

// --- ⏰ MONITOREO DE ALERTAS CON RESEND ---
// --- ⏰ MONITOREO DE ALERTAS (MIGRADO DE AZURE A SUPABASE/RESEND) ---
async function sistemaDeAlertas() {
    try {
        console.log("⏱️ Revisando estado de las incubadoras...");

        // 1. Consultamos incubadoras activas
        const { data: incubadoras, error: errInc } = await supabase
            .from('estado_incubadora')
            .select('*')
            .eq('estado', 'Activa');

        if (errInc || !incubadoras || incubadoras.length === 0) {
            console.log("Empty: No hay incubadoras en estado 'Activa'.");
            return;
        }

        for (let r of incubadoras) {
            // 2. Buscamos la última lectura de esta incubadora específica
            const { data: lecturas } = await supabase
                .from('datos_incubadora')
                .select('temperatura, humedad, fecha_hora')
                .eq('id_incubadora', r.id_incubadora)
                .order('fecha_hora', { ascending: false })
                .limit(1);

            const d = lecturas?.[0];
            if (!d) continue; // Si no hay datos, saltamos a la siguiente

            const ahora = new Date();
            const fechaLectura = new Date(d.fecha_hora);
            const diferenciaMinutos = (ahora - fechaLectura) / 60000;

            // Log de depuración similar al que tenías en Azure
            console.log(`Revisando ${r.id_incubadora}: Dif. minutos: ${diferenciaMinutos.toFixed(2)}`);

            let alertMsg = "";

            // --- 🔹 LÓGICA DE CONDICIONES (IGUAL A TU CÓDIGO ORIGINAL) ---
            
            // 1. CONDICIÓN: Desconexión (más de 2 minutos sin datos)
            if (diferenciaMinutos > 2) {
                alertMsg = `🚨 <b>ALERTA DE CONEXIÓN:</b> La incubadora ${r.id_incubadora} no envía datos hace más de 2 minutos.`;
            } 
            // 2. CONDICIÓN: Temperatura fuera de rango (+- 2°C)
            else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `🌡️ <b>ALERTA DE TEMPERATURA:</b> Actual: ${d.temperatura.toFixed(1)}°C (Deseada: ${r.set_temp}°C)`;
            }
            // 3. CONDICIÓN: Humedad alta (+5 del set)
            else if (d.humedad > (r.set_hum + 5)) {
                alertMsg = `💧 <b>ALERTA DE HUMEDAD:</b> Actual: ${d.humedad.toFixed(1)}% (Límite: ${r.set_hum + 5}%)`;
            }

            if (alertMsg) {
                // 3. Obtenemos el email del usuario asociado
                const { data: user } = await supabase
                    .from('usuarios')
                    .select('email')
                    .eq('id_incubadora', r.id_incubadora)
                    .maybeSingle();
                
                if (user?.email) {
                    try {
                        // 4. ENVÍO VÍA RESEND
                        await resend.emails.send({
                            from: 'SmartEncub <onboarding@resend.dev>', // Cambiar por tu dominio verificado luego
                            to: user.email,
                            subject: `⚠️ AVISO URGENTE: Incubadora ${r.id_incubadora}`,
                            html: `
                                <div style="font-family: sans-serif; border: 2px solid #e74c3c; padding: 20px; border-radius: 10px;">
                                    <h2 style="color: #e74c3c;">Notificación de Alerta</h2>
                                    <p>Estimado usuario,</p>
                                    <p>${alertMsg}</p>
                                    <hr>
                                    <p style="font-size: 0.8em; color: #7f8c8d;">Hora del reporte del servidor: ${ahora.toLocaleString()}</p>
                                </div>
                            `
                        });
                        console.log(`✅ Alerta enviada a ${user.email} para la incubadora ${r.id_incubadora}`);
                    } catch (sendError) {
                        console.error("❌ Error al enviar con Resend:", sendError.message);
                    }
                } else {
                    console.log(`🚫 No se encontró email para la incubadora ${r.id_incubadora}`);
                }
            }
        }
    } catch (err) {
        console.error("❌ Error en el sistema de monitoreo:", err.message);
    }
}

// Se mantiene la programación cada minuto
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
    const mensajeMQTT = JSON.stringify({
        id: data.id,
        estado: data.estado,
        set_temp: data.set_temp,
        set_hum: data.set_hum,
        set_dias: data.set_dias,
        set_rot: data.set_rot
    });

    if (mqttClient.connected) {
        try {
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
        console.error("⚠️ No hay conexión con HiveMQ");
        res.status(503).send("El servicio de mensajería no está disponible.");
    }
});

app.get("/ping", (req, res) => res.send("pong"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor activo en puerto " + PORT));
