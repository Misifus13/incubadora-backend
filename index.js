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

// --- 🔹 CONFIGURACIÓN NODEMAILER (BLINDAJE TOTAL) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // SSL Directo
    pool: true,   // Mantiene la conexión abierta para evitar nuevos timeouts
    maxConnections: 5,
    maxMessages: 100,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // Tu clave de 16 letras
    },
    tls: {
        rejectUnauthorized: false, // Ignora errores de certificado de red
        minVersion: "TLSv1.2"
    },
    connectionTimeout: 40000, // Aumentado a 40 segundos
    greetingTimeout: 40000,
    socketTimeout: 40000
});

// Verificación de salud del correo
transporter.verify((error) => {
    if (error) {
        console.error("❌ ERROR CRÍTICO SMTP:", error.message);
        console.log("👉 REVISA: 1. Contraseña de aplicación. 2. IP bloqueada en Gmail. 3. Puerto 465 en Render.");
    } else {
        console.log("📧 SISTEMA DE CORREO: Conexión establecida exitosamente.");
    }
});

// --- 📡 CONFIGURACIÓN MQTT ---
const mqttClient = mqtt.connect("mqtts://e46fb974d55a4c96a5bd632a3617db64.s1.eu.hivemq.cloud:8883", {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    reconnectPeriod: 1000,
    rejectUnauthorized: false
});

mqttClient.on("connect", () => {
    console.log("✅ MQTT: Conectado a HiveMQ");
    mqttClient.subscribe("jhosimar/rtc");
});

// --- 📩 PROCESAMIENTO DE DATOS ---
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
        } catch (err) { console.error("❌ Error MQTT:", err.message); }
    }
});

// --- ⏰ LÓGICA DE ALERTAS POR CORREO ---
async function sistemaDeAlertas() {
    console.log("🔍 [Cron] Revisando condiciones de incubadoras...");
    try {
        const { data: incubadoras } = await supabase.from('estado_incubadora').select('*').eq('estado', 'Activa');
        if (!incubadoras) return;

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
                alertMsg = `La incubadora <b>${r.id_incubadora}</b> ha perdido conexión (15+ min).`;
            } else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `Desviación de temperatura en <b>${r.id_incubadora}</b>: ${d.temperatura.toFixed(1)}°C (Set: ${r.set_temp}°C).`;
            }

            if (alertMsg) {
                const { data: user } = await supabase.from('usuarios').select('email').eq('id_incubadora', r.id_incubadora).maybeSingle();
                if (user?.email) {
                    console.log(`📧 Intentando enviar alerta a: ${user.email}`);
                    const mailOptions = {
                        from: `"Monitoreo SmartEncub" <${process.env.EMAIL_USER}>`,
                        to: user.email,
                        subject: `⚠️ ALERTA: ${r.id_incubadora}`,
                        html: `<div style="font-family:sans-serif; padding:20px; border:1px solid red;">
                                <h2>Alerta de Incubación</h2>
                                <p>${alertMsg}</p>
                                <hr><small>Este es un mensaje automático del sistema.</small>
                               </div>`
                    };

                    transporter.sendMail(mailOptions, (err, info) => {
                        if (err) console.error("❌ Fallo el envío final:", err.message);
                        else console.log("✅ Alerta enviada con éxito:", info.messageId);
                    });
                }
            }
        }
    } catch (err) { console.error("❌ Error en ciclo de alertas:", err.message); }
}

// Escaneo cada 10 minutos
cron.schedule('*/10 * * * *', sistemaDeAlertas);

// --- 🌐 RUTAS API ---
app.get("/ping", (req, res) => res.send("Servidor Activo"));

app.post("/login", async (req, res) => {
    const { usuario, contrasena } = req.body;
    const { data } = await supabase.from('usuarios').select('*').eq('usuario', usuario).eq('contrasena', contrasena).maybeSingle();
    res.json(data || { error: "No autorizado" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Backend operando en puerto " + PORT));
