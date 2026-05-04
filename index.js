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

// --- 🔥 SISTEMA DE ALERTAS (Cada 5 min) ---
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

            const d = lecturas && lecturas.length > 0 ? lecturas[0] : null;
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
                    .maybeSingle();

                if (user?.email) {
                    await transporter.sendMail({
                        from: `"SmartEncub Pro" <${process.env.EMAIL_USER}>`,
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

// --- 📡 MQTT: CONEXIÓN Y RECEPCIÓN ---
const mqttClient = mqtt.connect("mqtts://e46fb974d55a4c96a5bd632a3617db64.s1.eu.hivemq.cloud:8883", {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS
});

mqttClient.on("connect", () => {
    console.log("✅ Conectado a HiveMQ Cloud");
    // IMPORTANTE: El servidor debe estar suscrito para recibir mensajes
    mqttClient.subscribe("jhosimar/rtc", (err) => {
        if (!err) console.log("📡 Suscrito al tópico jhosimar/rtc");
    });
});

mqttClient.on("message", async (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        console.log("📩 Datos recibidos:", data);

        // 1. Validar contra tabla maestra
        const { data: existe } = await supabase
            .from('incubadoras')
            .select('id_incubadora')
            .eq('id_incubadora', data.id)
            .maybeSingle();
        
        if (!existe) return console.log(`🚫 ID ${data.id} no autorizado.`);

        if (data.tipo === "ESTADO") {
            // Actualizar estado (UPSERT: Inserta si no existe, actualiza si existe)
            const { error } = await supabase.from('estado_incubadora').upsert({
                id_incubadora: data.id,
                estado: data.estado,
                set_temp: data.set_temp,
                set_hum: data.set_hum,
                set_dias: data.set_dias,
                set_rot: data.set_rot,
                fecha_inicio: data.inicio_inc 
            });
            if (error) console.error("❌ Error al guardar estado:", error.message);
        } else {
            // Insertar lectura de sensores
            const { error } = await supabase.from('datos_incubadora').insert({
                id_incubadora: data.id,
                temperatura: data.temp,
                humedad: data.hum
            });
            if (error) console.error("❌ Error al guardar lectura:", error.message);
        }
    } catch (err) { console.error("❌ Error procesando MQTT:", err.message); }
});

// --- 🔐 RUTAS API (SUPABASE) ---

app.post("/login", async (req, res) => {
    const { usuario, contrasena } = req.body;
    const { data, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('usuario', usuario)
        .eq('contrasena', contrasena)
        .maybeSingle();
        
    if (error) return res.status(500).send("Error en el servidor");
    if (!data) return res.status(401).send("Usuario o contraseña incorrectos");
    res.json(data);
});

app.post("/registro", async (req, res) => {
    const { usuario, contrasena, celular, email } = req.body;
    const id_recibido = req.body.id_incubadora.trim().toUpperCase();

    // Comparar con tabla maestra
    const { data: maestra, error: errMaestra } = await supabase
        .from('incubadoras')
        .select('id_incubadora')
        .eq('id_incubadora', id_recibido)
        .maybeSingle();

    if (errMaestra || !maestra) {
        return res.status(400).send(`⚠️ El ID ${id_recibido} no es válido.`);
    }

    // Crear usuario
    const { error: errUser } = await supabase.from('usuarios').insert([
        { usuario, contrasena, id_incubadora: id_recibido, celular, email }
    ]);

    if (errUser) return res.status(400).send("⚠️ El usuario ya existe.");
    res.send("✅ Registro exitoso");
});

app.get("/datos/:id", async (req, res) => {
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
        .maybeSingle();
        
    if (error || !data) return res.json({ estado: "Inactiva" });
    res.json(data);
});

// Enviar configuración al ESP32 vía MQTT y actualizar Supabase
app.post("/actualizar-config", async (req, res) => {
    const data = req.body;
    
    try {
        // 1. ACTUALIZAR SUPABASE PRIMERO
        // Esto asegura que el Dashboard refleje el cambio de inmediato
        const { error: dbError } = await supabase
            .from('estado_incubadora')
            .upsert({
                id_incubadora: data.id,
                estado: data.estado,
                set_temp: data.set_temp,
                set_hum: data.set_hum,
                set_dias: data.set_dias,
                set_rot: data.set_rot,
                ultima_actualizacion: new Date().toISOString()
            });

        if (dbError) {
            console.error("❌ Error actualizando Supabase:", dbError.message);
            return res.status(500).send("Error al guardar en base de datos");
        }

        // 2. PREPARAR MENSAJE PARA EL ESP32
        const mensajeMQTT = JSON.stringify({
            id: data.id,
            estado: data.estado,
            set_temp: data.set_temp,
            set_hum: data.set_hum,
            set_dias: data.set_dias,
            set_rot: data.set_rot
        });

        // 3. ENVIAR POR MQTT
        if (mqttClient.connected) {
            mqttClient.publish("jhosimar/config", mensajeMQTT, (err) => {
                if (err) {
                    console.error("❌ Error MQTT:", err);
                    return res.status(500).send("Error al enviar comando al ESP32");
                }
                console.log("📤 Configuración enviada al ESP32 y guardada en DB:", mensajeMQTT);
                res.send("✅ Configuración actualizada y enviada");
            });
        } else {
            console.error("❌ MQTT Desconectado");
            res.status(503).send("Servidor MQTT no disponible");
        }

    } catch (e) { 
        console.error("❌ Error general:", e);
        res.status(500).send("Error interno del servidor"); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor en puerto " + PORT));
