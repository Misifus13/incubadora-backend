-- 1. Tabla Maestra de Hardware
CREATE TABLE incubadoras (
    id_incubadora VARCHAR(20) PRIMARY KEY
);

-- 2. Tabla de Usuarios
CREATE TABLE usuarios (
    id_usuario SERIAL PRIMARY KEY,
    usuario VARCHAR(50) NOT NULL UNIQUE,
    contrasena VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    celular VARCHAR(20),
    id_incubadora VARCHAR(20),
    CONSTRAINT FK_Usuarios_Incubadoras FOREIGN KEY (id_incubadora) 
        REFERENCES incubadoras(id_incubadora) ON DELETE SET NULL
);

-- 3. Tabla de Lecturas Históricas
CREATE TABLE datos_incubadora (
    id_dato SERIAL PRIMARY KEY,
    id_incubadora VARCHAR(20) NOT NULL,
    temperatura FLOAT,
    humedad FLOAT,
    fecha_hora TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT FK_Datos_Incubadoras FOREIGN KEY (id_incubadora) 
        REFERENCES incubadoras(id_incubadora) ON DELETE CASCADE
);

-- 4. Tabla de Estado y Configuración (Para control PID)
CREATE TABLE estado_incubadora (
    id_incubadora VARCHAR(20) PRIMARY KEY,
    estado VARCHAR(20) DEFAULT 'Inactiva',
    set_temp FLOAT,
    set_hum FLOAT,
    set_dias INT,
    set_rot FLOAT,
    fecha_inicio BIGINT DEFAULT 0,
    ultima_actualizacion TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT FK_Estado_Incubadoras FOREIGN KEY (id_incubadora) 
        REFERENCES incubadoras(id_incubadora) ON DELETE CASCADE
);
