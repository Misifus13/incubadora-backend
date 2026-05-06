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
// --- ⏰ MONITOREO DE ALERTAS (ADAPTADO A BREVO Y SUPABASE) ---
async function sistemaDeAlertas() {
    try {
        console.log("⏱️ Revisando estado de las incubadoras...");

        // 1. Consultamos las incubadoras activas y sus dueños (INNER JOIN)
        // Nota: En Supabase, para hacer un JOIN, la tabla debe tener la Relación (Foreign Key) definida.
        const { data: incubadoras, error: errInc } = await supabase
            .from('estado_incubadora')
            .select(`
                id_incubadora,
                set_temp,
                set_hum,
                estado,
                usuarios!inner (email)
            `)
            .eq('estado', 'Activa'); // Filtramos solo las Activas

        if (errInc) throw errInc;

        if (!incubadoras || incubadoras.length === 0) {
            console.log("Empty: No hay incubadoras en estado 'Activa' con usuarios asociados.");
            return;
        }

        for (let r of incubadoras) {
            // 2. Simulamos el CROSS APPLY obteniendo la última lectura de cada incubadora
            const { data: lecturas, error: errData } = await supabase
                .from('datos_incubadora')
                .select('temperatura, humedad, fecha_hora')
                .eq('id_incubadora', r.id_incubadora)
                .order('fecha_hora', { ascending: false })
                .limit(1);

            if (errData) continue;

            const d = lecturas?.[0];
            if (!d) continue;

            let alertMsg = "";
            const ahora = new Date();
            const fechaLectura = new Date(d.fecha_hora);
            const diferenciaMinutos = (ahora.getTime() - fechaLectura.getTime()) / 60000;

            console.log(`Revisando ${r.id_incubadora}: Dif. minutos: ${diferenciaMinutos.toFixed(2)}`);

            // --- LÓGICA DE CONDICIONES ---
            // 1. CONDICIÓN: Desconexión (más de 1 minuto sin datos)
            if (diferenciaMinutos > 1) {
                alertMsg = `🚨 <b>ALERTA DE CONEXIÓN:</b> La incubadora ${r.id_incubadora} no envía datos hace más de 1 minuto.`;
            } 
            // 2. CONDICIÓN: Temperatura fuera de rango (+- 2°C)
            else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `🌡️ <b>ALERTA DE TEMPERATURA:</b> Actual: ${d.temperatura.toFixed(1)}°C (Deseada: ${r.set_temp}°C)`;
            }
            // 3. CONDICIÓN: Humedad alta
            else if (d.humedad > (r.set_hum + 5)) {
                alertMsg = `💧 <b>ALERTA DE HUMEDAD:</b> Actual: ${d.humedad.toFixed(1)}% (Límite: ${r.set_hum + 5}%)`;
            }

            if (alertMsg) {
                const userEmail = r.usuarios?.email;
                
                if (userEmail) {
                    try {
                        let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

                        sendSmtpEmail.subject = `⚠️ AVISO URGENTE: Incubadora ${r.id_incubadora}`;
                        sendSmtpEmail.htmlContent = `
                            <div style="font-family: sans-serif; border: 2px solid #e74c3c; padding: 20px; border-radius: 10px;">
                                <h2 style="color: #e74c3c;">Notificación de Alerta</h2>
                                <p>Estimado usuario,</p>
                                <p>${alertMsg}</p>
                                <hr>
                                <p style="font-size: 0.8em; color: #7f8c8d;">Hora del reporte del servidor: ${ahora.toLocaleString()}</p>
                                <p style="font-size: 0.8em; color: #7f8c8d;">Última lectura: ${fechaLectura.toLocaleString()}</p>
                            </div>`;
                        
                        // IMPORTANTE: Cambia este correo por tu remitente verificado en Brevo
                        sendSmtpEmail.sender = { "name": "Sistema Incubadora Pro", "email": "tu-correo-verificado@gmail.com" };
                        sendSmtpEmail.to = [{ "email": userEmail }];

                        const response = await apiInstance.sendTransacEmail(sendSmtpEmail);
                        console.log(`✅ Alerta enviada a ${userEmail} para la incubadora ${r.id_incubadora}. ID: ${response.messageId}`);
                        
                    } catch (sendError) {
                        console.error(`❌ Error al enviar con Brevo a ${userEmail}:`, sendError.message);
                    }
                }
            }
        }
    } catch (err) {
        console.error("❌ Error en el sistema de monitoreo:", err.message);
    }
}

// Se ejecuta cada minuto como pediste
cron.schedule('* * * * *', () => {
    sistemaDeAlertas();
});

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
