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
    // Usamos .trim() para evitar espacios accidentales
    const usuario = document.getElementById("usuario").value.trim();
    const contrasena = document.getElementById("contrasena").value.trim();
    const id_incubadora = document.getElementById("id_incubadora").value.trim().toUpperCase();
    const celular = document.getElementById("celular").value.trim();
    const email = document.getElementById("email").value.trim();

    if (!usuario || !contrasena || !id_incubadora || !celular || !email) {
        alert("Por favor, completa todos los campos.");
        return;
    }

    try {
        btn.innerText = "Registrando...";
        btn.disabled = true;

        const res = await fetch("/registro", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ usuario, contrasena, id_incubadora, celular, email }) 
        });

        const text = await res.text();

        if (res.ok) {
            alert("✅ ¡Cuenta creada con éxito!");
            window.location = "index.html";
        } else {
            // Esto mostrará el error específico (ej: "ID no existe en tabla maestra")
            alert(text); 
        }

    } catch (error) {
        alert("Error de conexión. Verifica si tu servidor en Render está activo.");
        console.error(error);
    } finally {
        btn.innerText = "Crear cuenta";
        btn.disabled = false;
    }
}
