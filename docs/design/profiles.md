# Perfiles (#99, ADR-0016)

## Uso

En **Ajustes → Perfiles** se crean, renombran y abren perfiles. Cada uno
tiene sus propias cuentas, correo, contactos, notas, preferencias y
contraseñas, y se abre en su propia ventana; la ventana muestra el nombre del
perfil. El perfil existente se llama «Perfil principal». Un perfil que nunca
se abrió puede borrarse.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 Rust (`secrets.rs`) | El perfil por defecto conserva los nombres de llavero; los demás llevan su id y no coinciden entre sí |
| N1 Go (`profiles_test.go`) | Argumento y variable de entorno; crear con id legible y único; nombre vacío o repetido rechazado; renombrar y título de ventana; rutas, bloqueo y entorno del núcleo propios del perfil, binario y actualizaciones compartidos; perfil desconocido o mal formado abre el principal; lista dañada no se reescribe; solo se borra un perfil sin datos; abrir lanza un proceso y no lo hace dos veces; la página recibe el perfil y solo cambia el documento |
| N2 (`profile.test.ts`, `ProfilesGroup.test.tsx`) | Claves de almacenamiento por perfil; lista, apertura, creación con aviso de nombre repetido y borrado solo de perfiles vacíos |
| N4 pendiente | Dos perfiles abiertos a la vez en Windows |
