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
        btn.innerText = "Verificando...";
        btn.disabled = true;

        // CAMBIO CRUCIAL: Usamos ruta relativa para que funcione en Render
        const response = await fetch("/login", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({usuario, contrasena})
        });

        if (response.ok) {
            const data = await response.json();
            
            // Verificamos que el objeto tenga el id_incubadora (según tu tabla usuarios)
            if (data && data.id_incubadora) {
                localStorage.setItem("id_incubadora", data.id_incubadora);
                window.location = "dashboard.html";
            } else {
                alert("Error: No se encontró una incubadora asociada a este usuario.");
            }
        } else {
            const errorMsg = await response.text();
            alert(errorMsg || "Usuario o contraseña incorrectos.");
        }

    } catch (error) {
        alert("No se pudo conectar con el servidor. El servicio podría estar despertando, intenta de nuevo en unos segundos.");
        console.error("Error de red:", error);
    } finally {
        btn.innerText = "Ingresar";
        btn.disabled = false;
    }
}
