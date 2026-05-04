// 1. CONFIGURACIÓN DE RUTAS (Azure Backend)
const BASE_URL = "https://rg-incubadora-yo123-fwcfebdmdsg8dkgr.chilecentral-01.azurewebsites.net";
const API_DATOS = `${BASE_URL}/datos/`;
const API_ESTADO = `${BASE_URL}/estado/`;

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

    // Ciclo de actualización cada 5 segundos
    setInterval(() => {
        cargarEstadoActual();
        // Solo recarga la gráfica y sensores si el sistema está trabajando
        if (estadoActual.toUpperCase() === "ACTIVA") {
            cargarDatos();
        }
    }, 5000);
});

// 3. CONTROL DE VISIBILIDAD Y ESTADO
async function cargarEstadoActual() {
    try {
        const id = localStorage.getItem("id_incubadora");
        const res = await fetch(`${API_ESTADO}${id}`);
        if (!res.ok) throw new Error("Error en petición de estado");
        
        const data = await res.json();
        const content = document.getElementById("dashboardContent");
        const msgInactiva = document.getElementById("msgInactiva");
        const elEstado = document.getElementById("txtEstado");

        if (data) {
            // Manejo de case-sensitivity (estado o Estado)
            estadoActual = data.estado ?? data.Estado ?? "INACTIVA";
            elEstado.innerText = estadoActual;

            if (estadoActual.toUpperCase() === "INACTIVA") {
                content.style.display = "none";
                msgInactiva.style.display = "block";
                elEstado.style.color = "#f56565";
            } else {
                content.style.display = "block";
                msgInactiva.style.display = "none";
                elEstado.style.color = "#48bb78";

                // Actualizar Setpoints en la UI
                document.getElementById("setTemp").innerText = data.set_temp ?? data.Set_Temp ?? "0";
                document.getElementById("setHum").innerText = data.set_hum ?? data.Set_Hum ?? "0";
                document.getElementById("setDias").innerText = data.set_dias ?? data.Set_Dias ?? "0";

                // Tiempo restante con compensación de zona horaria
                const timerElement = document.getElementById("tiempoRestante");
                if (timerElement) {
                    const fechaInicio = data.fecha_inicio ?? data.Fecha_Inicio;
                    const setDias = data.set_dias ?? data.Set_Dias;
                    timerElement.innerText = calcularTiempoRestante(fechaInicio, setDias);
                }
            }
        }
    } catch (err) {
        console.error("Error cargando estado:", err);
    }
}

// 4. CARGAR DATOS DE SENSORES Y GRÁFICA
async function cargarDatos() {
    try {
        const id = localStorage.getItem("id_incubadora");
        // Solicitamos las últimas 20 lecturas para la gráfica
        const res = await fetch(`${API_DATOS}${id}?limite=20`);
        const data = await res.json();

        if (!data || data.length === 0) return;

        // Invertimos el array para que el tiempo avance de izquierda a derecha
        const datosOrdenados = [...data].reverse();
        const ultimo = datosOrdenados[datosOrdenados.length - 1];

        // Actualizar indicadores numéricos (Tiempo Real)
        document.getElementById("currentTemp").innerText = `${Number(ultimo.temperatura ?? ultimo.Temperatura ?? 0).toFixed(1)} °C`;
        document.getElementById("currentHum").innerText = `${Number(ultimo.humedad ?? ultimo.Humedad ?? 0).toFixed(1)} %`;

        dibujarGrafica(datosOrdenados);
    } catch (err) {
        console.error("Error cargando datos:", err);
    }
}

// 5. LÓGICA DE CHART.JS
function dibujarGrafica(data) {
    const labels = data.map(d => new Date(d.fecha_hora ?? d.Fecha_Hora).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const temps = data.map(d => d.temperatura ?? d.Temperatura);
    const hums = data.map(d => d.humedad ?? d.Humedad);

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

// 6. GESTIÓN DEL MODAL DE CONFIGURACIÓN
function abrirModal() {
    document.getElementById("inputTemp").value = document.getElementById("setTemp").innerText;
    document.getElementById("inputHum").value = document.getElementById("setHum").innerText;
    document.getElementById("inputDias").value = document.getElementById("setDias").innerText;
    document.getElementById("modalEdit").style.display = "flex";
}

function cerrarModal() {
    document.getElementById("modalEdit").style.display = "none";
}

async function guardarCambios() {
    const id = localStorage.getItem("id_incubadora");
    const payload = {
        id: id,
        tipo: "ESTADO",
        estado: "Activa",
        set_temp: parseFloat(document.getElementById("inputTemp").value),
        set_hum: parseFloat(document.getElementById("inputHum").value),
        set_dias: parseInt(document.getElementById("inputDias").value),
        set_rot: 0
    };

    try {
        const res = await fetch(`${BASE_URL}/actualizar-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            alert("✅ Configuración enviada correctamente");
            cerrarModal();
            cargarEstadoActual();
        } else {
            alert("❌ Error al actualizar");
        }
    } catch (err) {
        alert("❌ Error de conexión");
    }
}

// 7. FUNCIONES DE APOYO (TIEMPO Y CANCELACIÓN)
function calcularTiempoRestante(fechaInicioUnix, diasTotales) {
    if (!fechaInicioUnix || fechaInicioUnix == 0) return "---";

    // Compensación UTC-4 (Bolivia)
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

async function cancelarIncubacion() {
    if (!confirm("⚠️ ¿Estás seguro de cancelar? El sistema se apagará.")) return;

    const id = localStorage.getItem("id_incubadora");
    const payload = {
        id: id,
        tipo: "ESTADO",
        estado: "Inactiva"
    };

    try {
        const res = await fetch(`${BASE_URL}/actualizar-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            alert("🛑 Comando de parada enviado");
            cargarEstadoActual();
        }
    } catch (err) {
        alert("❌ Error de conexión");
    }
}

function logout() {
    localStorage.clear();
    window.location = "index.html";
}
