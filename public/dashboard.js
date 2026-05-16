
// 1. CONFIGURACIÓN DE CREDENCIALES
const SUPABASE_URL = "https://qpuvmkpgdcsahewfuqre.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwdXZta3BnZGNzYWhld2Z1cXJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MjY0NzYsImV4cCI6MjA5MzQwMjQ3Nn0.U0SQh1xIWh9IV6Bk3jVFr3V-AraEZG8rg40niwi-3cY";
const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const API_URL = "https://incubadora-backend.onrender.com"; // Reemplaza con tu URL real

let chart;
let estadoActual = "INACTIVA";

// 2. INICIALIZACIÓN
document.addEventListener("DOMContentLoaded", () => {
    const id = localStorage.getItem("id_incubadora");
    if (!id) {
        window.location = "index.html";
        return;
    }
    
    // Carga inicial
    cargarEstadoActual();
    cargarDatos();

    // Actualización automática cada 5 segundos
    setInterval(() => {
        cargarEstadoActual();
        if (estadoActual.toUpperCase() === "ACTIVA") {
            cargarDatos();
        }
    }, 5000);
});

// 3. OBTENER ESTADO (Control de visibilidad idéntico al de Azure)
async function cargarEstadoActual() {
    try {
        const id = localStorage.getItem("id_incubadora");
        
        const { data, error } = await _supabase
            .from('estado_incubadora')
            .select('*')
            .eq('id_incubadora', id)
            .single();

        if (error) throw error;

        const content = document.getElementById("dashboardContent");
        const msgInactiva = document.getElementById("msgInactiva");
        const elEstado = document.getElementById("txtEstado");

        if (data) {
            // Manejo de Mayúsculas/Minúsculas para mayor seguridad
            estadoActual = data.estado ?? "INACTIVA";
            elEstado.innerText = estadoActual;

            if (estadoActual.toUpperCase() === "INACTIVA") {
                content.style.display = "none";
                msgInactiva.style.display = "block";
                elEstado.style.color = "#f56565";
            } else {
                content.style.display = "block";
                msgInactiva.style.display = "none";
                elEstado.style.color = "#48bb78";

                // Sincronizar Setpoints
                document.getElementById("setTemp").innerText = data.set_temp ?? "0";
                document.getElementById("setHum").innerText = data.set_hum ?? "0";
                document.getElementById("setDias").innerText = data.set_dias ?? "0";
                document.getElementById("setRot").innerText = data.set_rot ?? "0";

                const timerElement = document.getElementById("tiempoRestante");
                if (timerElement) {
                    timerElement.innerText = calcularTiempoRestante(data.fecha_inicio, data.set_dias);
                }
            }
        }
    } catch (err) {
        console.error("Error cargando estado:", err.message);
    }
}

// 4. CARGAR LECTURAS PARA LA GRÁFICA (Últimas 20)
async function cargarDatos() {
    try {
        const id = localStorage.getItem("id_incubadora");
        
        const { data, error } = await _supabase
            .from('datos_incubadora')
            .select('*')
            .eq('id_incubadora', id)
            .order('fecha_hora', { ascending: false })
            .limit(20);

        if (error) throw error;
        if (!data || data.length === 0) return;

        // Invertimos para que la gráfica fluya de izquierda a derecha
        const datosOrdenados = [...data].reverse();
        const ultimo = datosOrdenados[datosOrdenados.length - 1];

        // Actualizar indicadores de Tiempo Real
        document.getElementById("currentTemp").innerText = `${Number(ultimo.temperatura ?? 0).toFixed(1)} °C`;
        document.getElementById("currentHum").innerText = `${Number(ultimo.humedad ?? 0).toFixed(1)} %`;

        dibujarGrafica(datosOrdenados);
    } catch (err) {
        console.error("Error cargando datos:", err.message);
    }
}

// 5. LÓGICA DE CHART.JS
function dibujarGrafica(data) {
    const labels = data.map(d => new Date(d.fecha_hora).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const temps = data.map(d => d.temperatura);
    const hums = data.map(d => d.humedad);

    const ctx = document.getElementById("grafica").getContext("2d");

    if (chart) {
        chart.data.labels = labels;
        chart.data.datasets[0].data = temps;
        chart.data.datasets[1].data = hums;
        chart.update();
        return;
    }

    chart = new Chart(ctx, {
        type: "line",
        data: {
            labels: labels,
            datasets: [
                { label: "Temp (°C)", data: temps, borderColor: "#ef4444", tension: 0.3, fill: false },
                { label: "Hum (%)", data: hums, borderColor: "#3b82f6", tension: 0.3, fill: false }
            ]
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false, 
            animation: false,
            scales: { y: { beginAtZero: false } }
        }
    });
}

// 6. GESTIÓN DE CONFIGURACIÓN Y MODAL
function abrirModal() {
    document.getElementById("inputTemp").value = document.getElementById("setTemp").innerText;
    document.getElementById("inputHum").value = document.getElementById("setHum").innerText;
    document.getElementById("inputDias").value = document.getElementById("setDias").innerText;
    document.getElementById("inputRot").value = document.getElementById("setRot").innerText;
    document.getElementById("modalEdit").style.display = "flex";
}

function cerrarModal() {
    document.getElementById("modalEdit").style.display = "none";
}

async function guardarCambios() {
    const id = localStorage.getItem("id_incubadora");
    
    // Preparamos el paquete de datos para el ESP32
    const payload = {
        id: id,
        estado: "Activa",
        set_temp: parseFloat(document.getElementById("inputTemp").value),
        set_hum: parseFloat(document.getElementById("inputHum").value),
        set_dias: parseInt(document.getElementById("inputDias").value),
        set_rot: parseFloat(document.getElementById("inputRot").value)
    };

    try {
        // Enviamos la orden directamente al servidor de Render
        const response = await fetch(`${API_URL}/actualizar-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error("El servidor de control no responde");

        alert("🚀 Configuración enviada. El ESP32 se está inicializando...");
        cerrarModal();
        
        // Esperamos 2 segundos para que el ESP32 reciba, procese 
        // y actualice la base de datos antes de refrescar la pantalla
        setTimeout(cargarEstadoActual, 2000); 
        
    } catch (err) {
        alert("❌ Error al conectar con el sistema: " + err.message);
    }
}

// 7. FUNCIONES DE APOYO
async function cancelarIncubacion() {
    if (!confirm("⚠️ ¿Estás seguro de cancelar? El sistema se apagará.")) return;

    const id = localStorage.getItem("id_incubadora");
    try {
        const { error } = await _supabase
            .from('estado_incubadora')
            .update({ estado: "Inactiva" })
            .eq('id_incubadora', id);

        if (error) throw error;

        alert("🛑 Comando de parada enviado");
        cargarEstadoActual();
    } catch (err) {
        alert("❌ Error: " + err.message);
    }
}

function calcularTiempoRestante(fechaInicioUnix, diasTotales) {
    if (!fechaInicioUnix || fechaInicioUnix === 0) return "---";
    const offsetBolivia = 4 * 60 * 60 * 1000;
    const fechaInicio = new Date((fechaInicioUnix * 1000) + offsetBolivia);
    const fechaFin = new Date(fechaInicio.getTime() + (diasTotales * 24 * 60 * 60 * 1000));
    const ahora = new Date();
    const diferencia = fechaFin - ahora;
    if (diferencia <= 0) return "¡Finalizada!";
    const dias = Math.floor(diferencia / (1000 * 60 * 60 * 24));
    const horas = Math.floor((diferencia % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutos = Math.floor((diferencia % (1000 * 60 * 60)) / (1000 * 60));
    return `${dias}d ${horas}h ${minutos}m`;
}

function logout() {
    localStorage.clear();
    window.location = "index.html";
}
