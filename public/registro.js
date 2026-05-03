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
    const celular = document.getElementById("celular").value;
    const email = document.getElementById("email").value;

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
            alert("✅ ¡Cuenta creada con éxito! Ya puedes iniciar sesión.");
            window.location = "index.html";
        } else {
            alert(text); 
        }

    } catch (error) {
        alert("Error de conexión con el servidor");
        console.error(error);
    } finally {
        btn.innerText = "Crear cuenta";
        btn.disabled = false;
    }
}
