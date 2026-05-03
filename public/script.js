// Función para mostrar u ocultar la contraseña
function togglePassword() {
    const passwordInput = document.getElementById("contrasena");
    const eyeIcon = document.getElementById("eyeIcon");
    
    if (passwordInput.type === "password") {
        passwordInput.type = "text";
        eyeIcon.classList.replace("fa-eye", "fa-eye-slash");
    } else {
        passwordInput.type = "password";
        eyeIcon.classList.replace("fa-eye-slash", "fa-eye");
    }
}

// Función principal de Login
async function login() {
    const btn = document.getElementById("btnLogin");
    const usuario = document.getElementById("usuario").value;
    const contrasena = document.getElementById("contrasena").value;

    if(!usuario || !contrasena) {
        alert("Por favor, ingresa tus credenciales.");
        return;
    }

    try {
        // Bloqueamos el botón para evitar múltiples clics
        btn.innerText = "Verificando...";
        btn.disabled = true;

        const response = await fetch("https://rg-incubadora-yo123-fwcfebdmdsg8dkgr.chilecentral-01.azurewebsites.net/login", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({usuario, contrasena})
        });

        const resultText = await response.text();
        let data;

        try {
            data = JSON.parse(resultText);
        } catch (parseError) {
            alert("Error en la respuesta del servidor.");
            console.error("No es JSON:", resultText);
            return;
        }

        if (Array.isArray(data) && data.length > 0) {
            // Guardamos el ID de la incubadora para usarlo en el dashboard
            localStorage.setItem("id_incubadora", data[0].id_incubadora);
            // Redirigir al panel de control
            window.location = "dashboard.html";
        } else {
            alert("Usuario o contraseña incorrectos.");
        }

    } catch (error) {
        alert("No se pudo conectar con el servidor. Revisa tu internet.");
        console.error("Error de red:", error);
    } finally {
        // Restauramos el botón pase lo que pase
        btn.innerText = "Ingresar";
        btn.disabled = false;
    }
}