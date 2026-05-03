// Función para mostrar/ocultar contraseña
function togglePassword() {
    const input = document.getElementById("contrasena");
    const icon = document.getElementById("eyeIcon");
    
    if (input.type === "password") {
        input.type = "text";
        icon.classList.replace("fa-eye", "fa-eye-slash");
    } else {
        input.type = "password";
        icon.classList.replace("fa-eye-slash", "fa-eye");
    }
}

async function registrar() {
    const btn = document.getElementById("btnRegistro");
    const usuario = document.getElementById("usuario").value;
    const contrasena = document.getElementById("contrasena").value;
    const id_incubadora = document.getElementById("id_incubadora").value;
    const celular = document.getElementById("celular").value; // <--- CAPTURAR CELULAR
    const email = document.getElementById("email").value; // <--- CAPTURAR EMAIL

    // Validar que todos los campos estén llenos
    if (!usuario || !contrasena || !id_incubadora || !celular || !email) {
        alert("Por favor, completa todos los campos, incluyendo el correo.");
        return;
    }

    try {
        btn.innerText = "Registrando...";
        btn.disabled = true;

        const res = await fetch("https://rg-incubadora-yo123-fwcfebdmdsg8dkgr.chilecentral-01.azurewebsites.net/registro", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            // ⚠️ AQUÍ ESTABA EL ERROR: Faltaba incluir 'email' en el objeto
            body: JSON.stringify({ usuario, contrasena, id_incubadora, celular, email }) 
        });

        const text = await res.text();

        // Si el servidor responde con el mensaje de éxito que pusimos en index.js
        if (text.includes("✅")) {
            alert("¡Cuenta creada con éxito! Ahora puedes iniciar sesión.");
            window.location = "index.html";
        } else {
            alert(text); // Muestra "⚠️ Usuario ya existe" u otros errores
        }

    } catch (error) {
        alert("Error de conexión con el servidor");
        console.error(error);
    } finally {
        btn.innerText = "Crear cuenta";
        btn.disabled = false;
    }
}