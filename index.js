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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 🔹 CONFIGURACIÓN NODEMAILER (SOLUCIÓN DEFINITIVA) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // SSL directo (más estable en Render)
    pool: true,   // Mantiene la conexión abierta
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // Contraseña de aplicación de 16 letras
    },
    tls: {
        rejectUnauthorized: false
    },
    connectionTimeout: 20000, // 20 segundos
    greetingTimeout: 20000,
    socketTimeout: 20000
});

// Verificación de conexión inicial
transporter.verify((error) => {
    if (error) {
        console.error("❌ Error SMTP:", error.message);
    } else {
        console.log("📧 Servidor de correo vinculado y listo para alertas");
    }
});

// --- 📡 MQTT: CONEXIÓN ROBUSTA ---
const mqttClient = mqtt.connect("mqtts://e46fb974d55a4c96a5bd632a3617db64.s1.eu.hivemq.cloud:8883", {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    keepalive: 60,
    reconnectPeriod: 1000,
    rejectUnauthorized: false
});

mqttClient.on("connect", () => {
    console.log("✅ Conectado a HiveMQ Cloud");
    mqttClient.subscribe("jhosimar/rtc");
});

// --- 🔥 REALTIME: ESCUCHAR CAMBIOS ---
let ultimoMensajeEnviado = "";
supabase
    .channel('cambios-db')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'estado_incubadora' }, (payload) => {
        const data = payload.new;
        const mensajeMQTT = JSON.stringify({
            id: data.id_incubadora,
            estado: data.estado,
            set_temp: data.set_temp,
            set_hum: data.set_hum,
            set_dias: data.set_dias,
            set_rot: data.set_rot
        });

        if (mensajeMQTT === ultimoMensajeEnviado) return;

        if (mqttClient.connected) {
            ultimoMensajeEnviado = mensajeMQTT;
            mqttClient.publish("jhosimar/config", mensajeMQTT);
            setTimeout(() => { ultimoMensajeEnviado = ""; }, 5000);
        }
    })
    .subscribe();

// --- 📩 RECEPCIÓN DE DATOS ---
mqttClient.on("message", async (topic, message) => {
    if (topic === "jhosimar/rtc") {
        try {
            const data = JSON.parse(message.toString());
            const { data: existe } = await supabase.from('incubadoras').select('id_incubadora').eq('id_incubadora', data.id).maybeSingle();
            if (!existe) return;

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
        } catch (err) { console.error("❌ Error en datos:", err.message); }
    }
});

// --- ⏰ MONITOREO DE ALERTAS ---
async function sistemaDeAlertas() {
    console.log("🔍 Revisando alertas...");
    try {
        const { data: incubadoras } = await supabase.from('estado_incubadora').select('*').eq('estado', 'Activa');
        if (!incubadoras || incubadoras.length === 0) return;

        for (let r of incubadoras) {
            const { data: lecturas } = await supabase
                .from('datos_incubadora')
                .select('temperatura, fecha_hora')
                .eq('id_incubadora', r.id_incubadora)
                .order('fecha_hora', { ascending: false })
                .limit(1);

            const d = lecturas?.[0];
            if (!d) continue;

            const diferenciaMinutos = (new Date() - new Date(d.fecha_hora)) / 60000;
            let alertMsg = "";

            if (diferenciaMinutos > 15) {
                alertMsg = `🚨 <b>CONEXIÓN PERDIDA:</b> La incubadora ${r.id_incubadora} no reporta hace 15 min.`;
            } else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `🌡️ <b>ALERTA TEMPERATURA:</b> ${d.temperatura.toFixed(1)}°C (Set: ${r.set_temp}°C)`;
            }

            if (alertMsg) {
                const { data: user } = await supabase.from('usuarios').select('email').eq('id_incubadora', r.id_incubadora).maybeSingle();
                
                if (user?.email) {
                    console.log(`📧 Enviando correo a: ${user.email}`);
                    try {
                        await transporter.sendMail({
                            from: `"SmartEncub Pro" <${process.env.EMAIL_USER}>`,
                            to: user.email,
                            subject: `⚠️ ALERTA SISTEMA: ${r.id_incubadora}`,
                            html: `<div style="border:2px solid red; padding:20px; font-family:sans-serif;">
                                    <h2>Notificación Urgente</h2>
                                    <p>${alertMsg}</p>
                                   </div>`
                        });
                        console.log("✅ Correo enviado con éxito");
                    } catch (err) {
                        console.error("❌ Error de envío:", err.message);
                    }
                }
            }
        }
    } catch (err) { console.error("❌ Error general alertas:", err.message); }
}

// Cada 10 minutos
cron.schedule('*/10 * * * *', sistemaDeAlertas);

// --- 🌐 API ---
app.post("/login", async (req, res) => {
    const { usuario, contrasena } = req.body;
    const { data } = await supabase.from('usuarios').select('*').eq('usuario', usuario).eq('contrasena', contrasena).maybeSingle();
    if (!data) return res.status(401).send("Error");
    res.json(data);
});

app.post("/actualizar-config", async (req, res) => {
    const data = req.body;
    const mensajeMQTT = JSON.stringify({
        id: data.id, estado: data.estado, set_temp: data.set_temp,
        set_hum: data.set_hum, set_dias: data.set_dias, set_rot: data.set_rot
    });

    if (mqttClient.connected) {
        mqttClient.publish("jhosimar/config", mensajeMQTT, { qos: 1 });
        res.send("✅ Enviado");
    } else {
        res.status(503).send("Error MQTT");
    }
});

app.get("/ping", (req, res) => res.send("pong"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor en puerto " + PORT));
