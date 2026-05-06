require('dotenv').config();
const mqtt = require("mqtt");
const { createClient } = require('@supabase/supabase-js');
const express = require("express");
const path = require("path");
const cors = require("cors");
const SibApiV3Sdk = require('@getbrevo/brevo'); // 🔹 Brevo SDK
const cron = require('node-cron');

const app = express();

// --- 📩 CONFIGURACIÓN DE BREVO ---
let apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
let apiKey = apiInstance.authentications['apiKey'];
apiKey.apiKey = process.env.BREVO_API_KEY; // 🔹 Usa tu API Key de Brevo

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- 🔹 CONFIGURACIÓN SUPABASE ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
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
supabase.channel('cambios-db').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'estado_incubadora' }, (payload) => {
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
}).subscribe();

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
        } catch (err) { console.error("❌ Error MQTT:", err.message); }
    }
});

// --- ⏰ MONITOREO DE ALERTAS ---
async function sistemaDeAlertas() {
    try {
        console.log("⏱️ Iniciando revisión de alertas...");
        const { data: incubadoras } = await supabase.from('estado_incubadora').select('*').eq('estado', 'Activa');

        if (!incubadoras || incubadoras.length === 0) {
            console.log("Empty: No hay incubadoras activas.");
            return;
        }

        for (let r of incubadoras) {
            const { data: lecturas } = await supabase.from('datos_incubadora').select('temperatura, humedad, fecha_hora').eq('id_incubadora', r.id_incubadora).order('fecha_hora', { ascending: false }).limit(1);

            const d = lecturas?.[0];
            if (!d) continue;

            const ahora = new Date();
            const fechaLectura = new Date(d.fecha_hora);
            const diferenciaMinutos = (ahora.getTime() - fechaLectura.getTime()) / 60000;

            console.log(`Revisando ${r.id_incubadora}: Ultima lectura hace ${diferenciaMinutos.toFixed(2)} min`);

            let alertMsg = "";
            if (diferenciaMinutos > 15) {
                alertMsg = `🚨 <b>CONEXIÓN PERDIDA:</b> La incubadora ${r.id_incubadora} lleva 15 min sin reportar.`;
            } else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `🌡️ <b>ALERTA TEMPERATURA:</b> ${d.temperatura.toFixed(1)}°C (Esperado: ${r.set_temp}°C)`;
            }

            if (alertMsg) {
                const { data: user } = await supabase.from('usuarios').select('email').eq('id_incubadora', r.id_incubadora).maybeSingle();
                
                if (user?.email) {
                    console.log(`📧 Enviando correo vía Brevo a: ${user.email}`);
                    try {
                        // 🔹 Lógica de envío con Brevo
                        let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

                        sendSmtpEmail.subject = `⚠️ ALERTA: ${r.id_incubadora}`;
                        sendSmtpEmail.htmlContent = `
                            <div style="padding:20px; border:2px solid red; font-family: sans-serif;">
                                <h2>Notificación de Sistema</h2>
                                <p>${alertMsg}</p>
                                <hr>
                                <small>Hora servidor: ${ahora.toLocaleString()}</small>
                            </div>`;
                        
                        // Remitente (Usa el correo con el que te registraste en Brevo)
                        sendSmtpEmail.sender = { "name": "SmartEncub", "email": "wilfred1130594@gmail.com" }; 
                        sendSmtpEmail.to = [{ "email": user.email }];

                        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
                        console.log("✅ Correo enviado exitosamente con Brevo. ID:", data.messageId);

                    } catch (sendError) {
                        console.error("❌ Error enviando con Brevo:", sendError.message);
                    }
                }
            }
        }
    } catch (err) { console.error("❌ Error Alertas:", err.message); }
}

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
    const mensajeMQTT = JSON.stringify({ id: data.id, estado: data.estado, set_temp: data.set_temp, set_hum: data.set_hum, set_dias: data.set_dias, set_rot: data.set_rot });

    if (mqttClient.connected) {
        mqttClient.publish("jhosimar/config", mensajeMQTT, { qos: 1 }, (err) => {
            if (err) return res.status(500).send("Error MQTT");
            res.send("✅ Comando enviado");
        });
    } else {
        res.status(503).send("Sin conexión MQTT");
    }
});

app.get("/ping", (req, res) => res.send("pong"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor activo en puerto " + PORT));
