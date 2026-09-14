# 🎨 Talleres Creativos

Sistema simple para administrar inventario, talleres, combos y ventas. Es una página web estática (`index.html`) que guarda su información en [Supabase](https://supabase.com) y se publica gratis con **GitHub Pages**.

## Estructura del proyecto

```
index.html            Página principal (login + navegación)
assets/
  ├─ styles.css        Estilos
  ├─ config.js          Aquí van tus llaves de Supabase
  └─ app.js              Toda la lógica de la app
supabase/
  └─ schema.sql          Script para crear las tablas en Supabase
```

## Puesta en marcha (10-15 min)

### 1. Crear el proyecto en Supabase
1. Entra a [supabase.com](https://supabase.com) y crea una cuenta / proyecto nuevo.
2. Espera a que termine de crearse (1-2 min).

### 2. Crear las tablas
1. En tu proyecto, ve a **SQL Editor → New query**.
2. Copia y pega **todo** el contenido de `supabase/schema.sql` y presiona **Run**.
3. Esto crea las tablas (`materials`, `workshop_types`, `combos`, `sessions`, `sales`, `settings`) y las reglas de seguridad (RLS): sin iniciar sesión, nadie puede leer ni modificar nada.

### 3. Crear tu usuario
1. Ve a **Authentication → Users → Add user**.
2. Captura tu correo y una contraseña, y marca **Auto Confirm User**.
3. Repite por cada persona que necesite acceso. No hay registro público: los usuarios se crean solo desde aquí.

### 4. Obtener tus llaves
1. Ve a **Project Settings (⚙️) → API**.
2. Copia el **Project URL**.
3. Copia la llave **anon public**.

### 5. Configurar el proyecto
Abre `assets/config.js` y reemplaza:
```js
const SUPABASE_URL = "https://TU-PROYECTO.supabase.co";
const SUPABASE_ANON_KEY = "TU-ANON-KEY-PUBLICA";
```
con tus valores reales. Guarda el archivo.

### 6. Subir a GitHub
1. Crea un repositorio nuevo en GitHub.
2. Sube todos los archivos y carpetas de este proyecto (ya con tu `config.js` editado) a la raíz del repositorio.

### 7. Activar GitHub Pages
1. En el repositorio, ve a **Settings → Pages**.
2. En **Source** elige **Deploy from a branch** → rama **main** → carpeta **/(root)**.
3. Guarda. En 1-2 minutos tu página estará en:
   ```
   https://TU-USUARIO.github.io/TU-REPOSITORIO/
   ```
4. Entra con el usuario que creaste en el paso 3.

## Uso rápido

- **Inicio**: resumen de ventas, costos y utilidad.
- **Inventario**: da de alta materiales (cantidad y costo total adquirido); el costo unitario y el precio sugerido se calculan solos.
- **Talleres**: crea tipos de taller (materiales por persona, margen, café) y registra cada taller impartido; descuenta inventario solo.
- **Juegos / Combos**: arma paquetes de materiales con su propio costo y margen.
- **Ventas**: vende un material suelto o un combo fuera de un taller.
- **Resultados**: totales de ventas, costo, utilidad y margen.
- **Administración**: crea talleres/combos/materiales rápido, configura el precio del café y descarga un respaldo en JSON.

## Notas importantes

- Los datos viven en Supabase; se necesita internet para usar la app.
- La llave `anon public` en `config.js` **no es secreta**, está diseñada para usarse en el navegador. La seguridad real la dan las políticas de RLS del `schema.sql`. Nunca uses la `service_role key` aquí.
- Para dar de alta a más usuarios, hazlo desde Supabase → Authentication → Users (no hay pantalla de registro).

---
**Proyecto:** Talleres Creativos · **Versión:** 1.0.0
