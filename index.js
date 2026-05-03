const mqtt = require("mqtt");
const { createClient } = require('@supabase/supabase-js'); // 🔹 Cambio a Supabase
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
// Reemplaza con tus credenciales de Supabase Dashboard
const supabaseUrl = 'https://TU_PROYECTO.supabase.co';
const supabaseKey = 'TU_ANON_KEY';
const supabase = createClient(supabaseUrl, supabaseKey);

// --- 🔹 CONFIGURACIÓN NODEMAILER ---
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, 
    auth: {
        user: 'wilfred1130594@gmail.com',
        pass: 'mhvz cruk pnzg lrgs' 
    }
});

// --- 🔥 SISTEMA DE ALERTAS ---
async function sistemaDeAlertas() {
    try {
        // Consultamos incubadoras activas con sus usuarios y última lectura
        const { data: incubadoras, error } = await supabase
            .from('estado_incubadora')
            .select(`
                id_incubadora, set_temp, set_hum, estado,
                usuarios ( email ),
                datos_incubadora ( temperatura, humedad, fecha_hora )
            `)
            .eq('estado', 'Activa');

        if (error) throw error;
        if (!incubadoras) return;

        for (let r of incubadoras) {
            // Supabase trae las lecturas como array, tomamos la más reciente (índice 0)
            const d = r.datos_incubadora[0]; 
            if (!d) continue;

            let alertMsg = "";
            const ahora = new Date();
            const diferenciaMinutos = (ahora - new Date(d.fecha_hora)) / 60000;

            console.log(`Revisando ${r.id_incubadora}: Dif. minutos: ${diferenciaMinutos.toFixed(2)}`);

            if (diferenciaMinutos > 2) {
                alertMsg = `🚨 <b>ALERTA DE CONEXIÓN:</b> La incubadora ${r.id_incubadora} no envía datos.`;
            } 
            else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `🌡️ <b>ALERTA DE TEMPERATURA:</b> Actual: ${d.temperatura.toFixed(1)}°C (Set: ${r.set_temp}°C)`;
            }
            else if (d.humedad > (r.set_hum + 5)) {
                alertMsg = `💧 <b>ALERTA DE HUMEDAD:</b> Actual: ${d.humedad.toFixed(1)}% (Límite: ${r.set_hum + 5}%)`;
            }

            if (alertMsg && r.usuarios?.email) {
                await transporter.sendMail({
                    from: '"SmartEncub Pro" <wilfred1130594@gmail.com>',
                    to: r.usuarios.email, 
                    subject: `⚠️ AVISO URGENTE: Incubadora ${r.id_incubadora}`,
                    html: `<div style="font-family:sans-serif; border:2px solid #e74c3c; padding:20px; border-radius:10px;">
                            <h2 style="color:#e74c3c;">Notificación de Alerta</h2>
                            <p>${alertMsg}</p>
                            <hr><p style="font-size:0.8em;">Servidor: ${ahora.toLocaleString()}</p>
                           </div>`
                });
                console.log(`✅ Alerta enviada a ${r.usuarios.email}`);
            }
        }
    } catch (err) {
        console.error("❌ Error monitoreo:", err.message);
    }
}

cron.schedule('* * * * *', sistemaDeAlertas);

// --- 🔹 MQTT ---
const mqttClient = mqtt.connect(
    "mqtts://e46fb974d55a4c96a5bd632a3617db64.s1.eu.hivemq.cloud:8883",
    { username: "jhosimar", password: "Leavemealone1305" }
);

mqttClient.on("connect", () => {
    console.log("✅ MQTT Conectado");
    mqttClient.subscribe("jhosimar/rtc");
});

mqttClient.on("message", async (topic, message) => {
    try {
        const data = JSON.parse(message.toString());

        if (data.tipo === "ESTADO") {
            // UPSERT: Si existe actualiza, si no inserta
            await supabase.from('estado_incubadora').upsert({
                id_incubadora: data.id,
                estado: data.estado,
                set_temp: data.set_temp,
                set_hum: data.set_hum,
                set_dias: data.set_dias,
                set_rot: data.set_rot,
                fecha_inicio: data.inicio_inc,
                ultima_actualizacion: new Date()
            }, { onConflict: 'id_incubadora' });
            console.log("⚙️ Estado actualizado");
        } else {
            await supabase.from('datos_incubadora').insert({
                id_incubadora: data.id,
                temperatura: data.temp,
                humedad: data.hum
            });
            console.log("📥 Lectura guardada");
        }
    } catch (err) {
        console.error("❌ Error MQTT:", err.message);
    }
});

// --- 🔐 RUTAS API ---

app.post("/login", async (req, res) => {
    const { usuario, contrasena } = req.body;
    const { data, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('usuario', usuario)
        .eq('contrasena', contrasena);

    if (error) return res.status(500).send(error.message);
    res.json(data);
});

app.post("/registro", async (req, res) => {
    const { usuario, contrasena, id_incubadora, celular, email } = req.body;
    const { error } = await supabase.from('usuarios').insert([
        { usuario, contrasena, id_incubadora, celular, email }
    ]);

    if (error) return res.send("⚠️ Error: " + error.message);
    res.send("✅ Usuario creado exitosamente");
});

app.get("/datos/:id", async (req, res) => {
    const { id } = req.params;
    const { limite } = req.query;

    let query = supabase.from('datos_incubadora').select('*').eq('id_incubadora', id).order('fecha_hora', { ascending: false });
    if (limite === "20") query = query.limit(20);

    const { data, error } = await query;
    if (error) return res.status(500).send(error.message);
    res.json(data);
});

app.get("/estado/:id", async (req, res) => {
    const { data, error } = await supabase
        .from('estado_incubadora')
        .select('estado, set_temp, set_hum, set_dias, fecha_inicio')
        .eq('id_incubadora', req.params.id)
        .single();

    if (error || !data) {
        return res.json({ estado: "Desconectada", set_temp: 0, set_hum: 0, set_dias: 0, fecha_inicio: 0 });
    }
    res.json(data);
});

app.post("/actualizar-config", async (req, res) => {
    const data = req.body;
    try {
        if (data.estado === "Inactiva") {
            await supabase.from('estado_incubadora')
                .update({ fecha_inicio: 0 })
                .eq('id_incubadora', data.id);
        }

        mqttClient.publish("jhosimar/config", JSON.stringify(data));
        res.status(200).send("Configuración enviada");
    } catch (err) {
        res.status(500).send("Error interno");
    }
});

// --- 🚀 SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor corriendo en puerto " + PORT));