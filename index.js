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

// --- 🔹 CONFIGURACIÓN NODEMAILER (CORREGIDA) ---
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // false para usar STARTTLS en puerto 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        // Esto ayuda a que Render no bloquee la conexión por certificados
        rejectUnauthorized: false 
    },
    connectionTimeout: 10000, // 10 segundos de espera
});

// Verificación de conexión inicial al servidor de correo
transporter.verify(function (error, success) {
    if (error) {
        console.error("❌ Error en la configuración de correo:", error);
    } else {
        console.log("📧 Servidor de correo de Google listo para enviar mensajes");
    }
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

// --- 🔥 REALTIME: ESCUCHAR CAMBIOS EN SUPABASE Y REENVIAR AL ESP32 ---
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

            // Bloqueo de bucle infinito
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

// --- ⏰ MONITOREO DE ALERTAS CON RASTREADORES ---
async function sistemaDeAlertas() {
    console.log("🔍 Iniciando revisión de alertas programada..."); // RASTREADOR 1
    
    try {
        const { data: incubadoras, error: errInc } = await supabase
            .from('estado_incubadora')
            .select('*')
            .eq('estado', 'Activa');

        if (errInc) console.error("❌ Error leyendo incubadoras:", errInc);
        if (!incubadoras || incubadoras.length === 0) {
            return console.log("ℹ️ No hay incubadoras activas en la base de datos.");
        }

        for (let r of incubadoras) {
            console.log(`📌 Revisando incubadora: ${r.id_incubadora}`); // RASTREADOR 2
            
            const { data: lecturas, error: errLec } = await supabase
                .from('datos_incubadora')
                .select('temperatura, humedad, fecha_hora')
                .eq('id_incubadora', r.id_incubadora)
                .order('fecha_hora', { ascending: false })
                .limit(1);

            if (errLec) console.error("❌ Error leyendo datos:", errLec);
            
            const d = lecturas?.[0];
            if (!d) {
                console.log(`⚠️ Sin lecturas previas para ${r.id_incubadora}`);
                continue;
            }

            const fechaLectura = new Date(d.fecha_hora);
            const ahora = new Date();
            const diferenciaMinutos = (ahora - fechaLectura) / 60000;
            
            console.log(`⏱️ Última lectura hace: ${diferenciaMinutos.toFixed(2)} mins. Temp actual: ${d.temperatura}°C, Set: ${r.set_temp}°C`); // RASTREADOR 3

            let alertMsg = "";

            if (diferenciaMinutos > 15) {
                alertMsg = `🚨 <b>CONEXIÓN PERDIDA:</b> La incubadora ${r.id_incubadora} lleva 15 min sin reportar.`;
            } else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `🌡️ <b>ALERTA TEMPERATURA:</b> ${d.temperatura.toFixed(1)}°C (Esperado: ${r.set_temp}°C)`;
            }

            if (alertMsg) {
                console.log(`⚠️ Alerta disparada: ${alertMsg}`); // RASTREADOR 4
                
                const { data: user, error: errUsr } = await supabase
                    .from('usuarios')
                    .select('email')
                    .eq('id_incubadora', r.id_incubadora)
                    .maybeSingle();
                
                if (errUsr) console.error("❌ Error buscando usuario:", errUsr);

                if (user?.email) {
                    console.log(`📧 Intentando enviar correo final a: ${user.email}`); // RASTREADOR 5
                    try {
                        const info = await transporter.sendMail({
                            from: `"SmartEncub Pro" <${process.env.EMAIL_USER}>`,
                            to: user.email,
                            subject: `⚠️ ALERTA DE SISTEMA: ${r.id_incubadora}`,
                            html: `<div style="padding:20px; border:2px solid red; font-family: sans-serif; max-width: 600px; margin: auto;">
                                    <h2 style="color: red; text-align: center;">Notificación Crítica</h2>
                                    <p style="font-size: 16px;">${alertMsg}</p>
                                    <hr>
                                    <small style="color: gray;">Este es un mensaje automático del sistema de control y monitoreo de SmartEncub Pro.</small>
                                   </div>`
                        });
                        console.log("✅ CORREO ENVIADO EXITOSAMENTE, ID:", info.messageId);
                    } catch (sendError) {
                        console.error("❌ Error de Nodemailer al intentar enviar:", sendError.message);
                    }
                } else {
                    console.log(`🚫 Falla crítica: El ID ${r.id_incubadora} no tiene un email válido registrado en la tabla 'usuarios'`);
                }
            } else {
                console.log(`✅ Todo normal para ${r.id_incubadora}, no se requieren alertas.`);
            }
        }
    } catch (err) { 
        console.error("❌ Error general en la función sistemaDeAlertas:", err.message); 
    }
}

// Ejecutar cada 10 minutos
cron.schedule('*/10 * * * *', sistemaDeAlertas);

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
        res.status(503).send("El servicio de mensajería no está disponible. Intenta de nuevo.");
    }
});

app.get("/ping", (req, res) => res.send("pong")); 

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor activo en puerto " + PORT));
