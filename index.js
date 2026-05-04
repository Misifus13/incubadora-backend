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
        // Coincide con tabla 'estado_incubadora' y campo 'estado'
        const { data: incubadoras, error: errInc } = await supabase
            .from('estado_incubadora')
            .select('*')
            .eq('estado', 'Activa'); // Sensible a mayúsculas según tu corrección

        if (errInc || !incubadoras) return;

        for (let r of incubadoras) {
            // Coincide con tabla 'datos_incubadora' y campos 'temperatura', 'humedad', 'fecha_hora'
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
                // Coincide con tabla 'usuarios'
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
        // Verifica contra tabla maestra 'incubadoras'
        const { data: existe } = await supabase.from('incubadoras').select('id_incubadora').eq('id_incubadora', data.id).single();
        
        if (existe) {
            if (data.tipo === "ESTADO") {
                // Coincide con tabla 'estado_incubadora'
                await supabase.from('estado_incubadora').upsert({
                    id_incubadora: data.id,
                    estado: data.estado,
                    set_temp: data.set_temp,
                    set_hum: data.set_hum,
                    set_dias: data.set_dias,
                    set_rot: data.set_rot,
                    fecha_inicio: data.inicio_inc // Mapeo de BIGINT para fecha_inicio
                });
            } else {
                // Coincide con tabla 'datos_incubadora'
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
    
    const { data, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('usuario', usuario)
        .eq('contrasena', contrasena)
        .maybeSingle(); // Cambiado de .single() para evitar errores 406
        
    if (error) return res.status(500).send("Error en el servidor");
    if (!data) return res.status(401).send("Usuario o contraseña incorrectos");
    
    res.json(data); // Envía el objeto del usuario directamente
});

app.post("/registro", async (req, res) => {
    const id_recibido = req.body.id_incubadora.trim().toUpperCase();
    const { usuario, contrasena, celular, email } = req.body;

    // 1. Validar contra tabla maestra 'incubadoras'
    const { data: maestra, error: errMaestra } = await supabase
        .from('incubadoras')
        .select('id_incubadora')
        .eq('id_incubadora', id_recibido)
        .single();

    if (errMaestra || !maestra) {
        return res.status(400).send(`⚠️ El ID ${id_recibido} no existe en la tabla maestra.`);
    }

    // 2. Inicializar en 'estado_incubadora' para evitar errores de FK
    await supabase.from('estado_incubadora').upsert({ id_incubadora: id_recibido }, { onConflict: 'id_incubadora' });

    // 3. Insertar en tabla 'usuarios' respetando tus campos
    const { error: errUser } = await supabase.from('usuarios').insert([
        { 
            usuario, 
            contrasena, 
            id_incubadora: id_recibido, 
            celular, 
            email 
        }
    ]);

    if (errUser) return res.status(400).send("⚠️ Error al crear usuario: " + errUser.message);

    res.send("✅ Registro exitoso");
});

app.get("/datos/:id", async (req, res) => {
    // Implementación de tu preferencia de últimas 20 lecturas
    const limite = parseInt(req.query.limite) || 20;
    const { data, error } = await supabase
        .from('datos_incubadora')
        .select('*')
        .eq('id_incubadora', req.params.id)
        .order('fecha_hora', { ascending: false })
        .limit(limite);
        
    if (error) return res.status(500).send(error.message);
    res.json(data);
});

app.get("/estado/:id", async (req, res) => {
    const { data, error } = await supabase
        .from('estado_incubadora')
        .select('*')
        .eq('id_incubadora', req.params.id)
        .single();
        
    if (error || !data) return res.json({ estado: "Inactiva" });
    res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor en puerto " + PORT));
