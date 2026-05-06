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

// --- 🔹 CONFIGURACIÓN NODEMAILER (GMAIL OPTIMIZADO) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // Tu contraseña de aplicación de 16 letras
    },
    pool: true, // Mantiene la conexión abierta para mayor velocidad
    tls: {
        rejectUnauthorized: false // Evita bloqueos de certificados en Render
    },
    connectionTimeout: 30000, 
    greetingTimeout: 30000,   
    socketTimeout: 30000      
});

// Verificación inmediata de la conexión al iniciar
transporter.verify((error) => {
    if (error) {
        console.error("❌ Error inicial de Nodemailer:", error.message);
    } else {
        console.log("📧 Servidor de correo vinculado y listo para enviar alertas.");
    }
});

// --- 📡 CONFIGURACIÓN MQTT (HIVEMQ) ---
const mqttClient = mqtt.connect("mqtts://e46fb974d55a4c96a5bd632a3617db64.s1.eu.hivemq.cloud:8883", {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    reconnectPeriod: 1000,
    rejectUnauthorized: false
});

mqttClient.on("connect", () => {
    console.log("✅ Conectado a HiveMQ Cloud");
    mqttClient.subscribe("jhosimar/rtc");
});

// --- 📩 RECEPCIÓN DE DATOS Y PERSISTENCIA ---
mqttClient.on("message", async (topic, message) => {
    if (topic === "jhosimar/rtc") {
        try {
            const data = JSON.parse(message.toString());
            
            // Verificación de ID
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

// --- ⏰ SISTEMA DE ALERTAS DINÁMICO ---
async function sistemaDeAlertas() {
    console.log("🔍 Revisando parámetros de incubadoras activas...");
    
    try {
        const { data: incubadoras } = await supabase
            .from('estado_incubadora')
            .select('*')
            .eq('estado', 'Activa');

        if (!incubadoras || incubadoras.length === 0) return;

        for (let r of incubadoras) {
            // Obtener la última lectura de esta incubadora específica
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

            // Lógica de validación
            if (diferenciaMinutos > 15) {
                alertMsg = `🚨 <b>CONEXIÓN PERDIDA:</b> La incubadora ${r.id_incubadora} dejó de reportar hace ${diferenciaMinutos.toFixed(0)} min.`;
            } else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `🌡️ <b>ALERTA DE TEMPERATURA:</b> Actual: ${d.temperatura.toFixed(1)}°C (Objetivo: ${r.set_temp}°C)`;
            }

            // Si hay alerta, buscamos al dueño
            if (alertMsg) {
                const { data: user } = await supabase
                    .from('usuarios')
                    .select('email')
                    .eq('id_incubadora', r.id_incubadora)
                    .maybeSingle();

                if (user?.email) {
                    console.log(`📧 Disparando alerta para: ${user.email}`);
                    try {
                        await transporter.sendMail({
                            from: `"SmartEncub Pro" <${process.env.EMAIL_USER}>`,
                            to: user.email,
                            subject: `⚠️ URGENTE: Estado de Incubadora ${r.id_incubadora}`,
                            html: `
                                <div style="font-family: Arial; border: 1px solid #eee; padding: 20px; max-width: 500px;">
                                    <h2 style="color: #d9534f;">Aviso del Sistema</h2>
                                    <p style="font-size: 16px;">${alertMsg}</p>
                                    <p style="color: #666; font-size: 12px; margin-top: 20px;">
                                        Este es un aviso automático de tu panel de monitoreo SmartEncub.
                                    </p>
                                </div>`
                        });
                        console.log(`✅ Alerta enviada con éxito a ${user.email}`);
                    } catch (mailErr) {
                        console.error(`❌ Error enviando a ${user.email}:`, mailErr.message);
                    }
                }
            }
        }
    } catch (err) { console.error("❌ Error en ciclo de alertas:", err.message); }
}

// Escaneo cada 10 minutos para evitar bloqueos por SPAM de Gmail
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
        mqttClient.publish("jhosimar/config", mensajeMQTT, { qos: 1 });
        res.send("✅ Configuración enviada al ESP32");
    } else {
        res.status(503).send("Servicio MQTT no disponible");
    }
});

app.get("/ping", (req, res) => res.send("Servidor Vivo 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor en línea en puerto " + PORT));
