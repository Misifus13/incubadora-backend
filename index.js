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

// --- 🔹 CONFIGURACIÓN NODEMAILER ---
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- 🔥 SISTEMA DE ALERTAS ---
async function sistemaDeAlertas() {
    try {
        const { data: incubadoras, error: errInc } = await supabase
            .from('estado_incubadora')
            .select('*')
            .eq('estado', 'Activa');

        if (errInc || !incubadoras) return;

        for (let r of incubadoras) {
            const { data: lecturas } = await supabase
                .from('datos_incubadora')
                .select('temperatura, humedad, fecha_hora')
                .eq('id_incubadora', r.id_incubadora)
                .order('fecha_hora', { ascending: false })
                .limit(1);

            const d = lecturas ? lecturas[0] : null;
            if (!d) continue;

            let alertMsg = "";
            const ahora = new Date();
            const diferenciaMinutos = (ahora - new Date(d.fecha_hora)) / 60000;

            if (diferenciaMinutos > 12) {
                alertMsg = `🚨 <b>ALERTA DE CONEXIÓN:</b> La incubadora ${r.id_incubadora} no envía datos.`;
            } else if (Math.abs(d.temperatura - r.set_temp) >= 2) {
                alertMsg = `🌡️ <b>ALERTA DE TEMPERATURA:</b> Actual: ${d.temperatura.toFixed(1)}°C (Set: ${r.set_temp}°C)`;
            }

            if (alertMsg) {
                const { data: user } = await supabase
                    .from('usuarios')
                    .select('email')
                    .eq('id_incubadora', r.id_incubadora)
                    .single();

                if (user?.email) {
                    await transporter.sendMail({
                        from: '"SmartEncub Pro" <wilfred1130594@gmail.com>',
                        to: user.email, 
                        subject: `⚠️ AVISO: ${r.id_incubadora}`,
                        html: `<div style="font-family:sans-serif; border:2px solid #e74c3c; padding:20px;">
                                <h2>Alerta de Incubadora</h2><p>${alertMsg}</p></div>`
                    });
                }
            }
        }
    } catch (err) { console.error("❌ Error monitoreo:", err.message); }
}
cron.schedule('*/5 * * * *', sistemaDeAlertas);

// --- 🔹 MQTT ---
const mqttClient = mqtt.connect("mqtts://e46fb974d55a4c96a5bd632a3617db64.s1.eu.hivemq.cloud:8883", {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS
});

mqttClient.on("message", async (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        
        // Verificamos si existe en la tabla Maestra antes de insertar/actualizar
        const { data: existe } = await supabase.from('incubadoras').select('id_incubadora').eq('id_incubadora', data.id).single();
        
        if (existe) {
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
        }
    } catch (err) { console.error("❌ Error MQTT:", err.message); }
});

// --- 🔐 RUTAS API ---

app.post("/login", async (req, res) => {
    const { usuario, contrasena } = req.body;
    const { data, error } = await supabase.from('usuarios').select('*').eq('usuario', usuario).eq('contrasena', contrasena).single();
    if (error || !data) return res.status(401).send("Credenciales incorrectas");
    res.json(data);
});

app.post("/registro", async (req, res) => {
    // Usamos .trim() para limpiar lo que envíe el usuario
    const { usuario, contrasena, celular, email } = req.body;
    const id_incubadora = req.body.id_incubadora.trim(); 

    // Buscamos si existe (usando una consulta más simple)
    const { data: listaMaestra, error: errMaestra } = await supabase
        .from('incubadoras')
        .select('id_incubadora')
        .eq('id_incubadora', id_incubadora);

    if (errMaestra || !listaMaestra || listaMaestra.length === 0) {
        return res.status(400).send(`⚠️ El ID ${id_incubadora} no está autorizado.`);
    }

    // El resto del código de registro sigue igual...
    await supabase.from('estado_incubadora').upsert({ id_incubadora }, { onConflict: 'id_incubadora' });
    const { error } = await supabase.from('usuarios').insert([{ usuario, contrasena, id_incubadora, celular, email }]);

    if (error) return res.status(400).send("⚠️ Error: " + error.message);
    res.send("✅ Registro exitoso");
});

app.get("/datos/:id", async (req, res) => {
    const limite = parseInt(req.query.limite) || 20;
    const { data, error } = await supabase.from('datos_incubadora').select('*').eq('id_incubadora', req.params.id).order('fecha_hora', { ascending: false }).limit(limite);
    if (error) return res.status(500).send(error.message);
    res.json(data);
});

app.get("/estado/:id", async (req, res) => {
    const { data, error } = await supabase.from('estado_incubadora').select('*').eq('id_incubadora', req.params.id).single();
    if (error || !data) return res.json({ estado: "Inactiva" });
    res.json(data);
});

// --- 🚀 SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor en puerto " + PORT));
