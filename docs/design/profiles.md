# Perfiles (#99, ADR-0016)

## Uso

En **Ajustes → Perfiles** se crean, renombran y abren perfiles. Cada uno
tiene sus propias cuentas, correo, contactos, notas, preferencias y
contraseñas, y se abre en su propia ventana; la ventana muestra el nombre del
perfil. El perfil existente se llama «Perfil principal».

Otro perfil se puede borrar desde aquí si no está abierto. Si nunca se
abrió, basta confirmar. Si tiene datos, hay que escribir su nombre; su
núcleo borra antes sus entradas del llavero, y si no puede, se pregunta
antes de borrar nada (ADR-0038).

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N1 Rust (`secrets.rs`, `profile_purge.rs`) | El perfil por defecto conserva los nombres de llavero; los demás llevan su id y no coinciden entre sí; la purga nombra cada tipo de secreto, borra los del perfil y no otros, y avisa si aparece un lugar nuevo que guarda secretos |
| N1 Go (`profiles_test.go`) | Argumento y variable de entorno; crear con id legible y único; nombre vacío o repetido rechazado; renombrar y título de ventana; rutas, bloqueo y entorno del núcleo propios del perfil, binario y actualizaciones compartidos; perfil desconocido o mal formado abre el principal; lista dañada no se reescribe; un perfil sin datos se borra sin escribir su nombre; uno con datos solo con su nombre exacto, después de purgar su llavero; uno abierto (con su cerrojo tomado) no se borra; una purga fallida no borra nada salvo que se elija; la purga se ejecuta con el entorno del perfil que se borra; el núcleo real purga un perfil con nombre y rechaza el principal; abrir lanza un proceso y no lo hace dos veces; la página recibe el perfil y solo cambia el documento |
| N2 (`profile.test.ts`, `ProfilesGroup.test.tsx`) | Claves de almacenamiento por perfil; lista, apertura, creación con aviso de nombre repetido; borrado con el nombre exacto y segunda pregunta si la purga falla |
| N4 pendiente | Dos perfiles abiertos a la vez en Windows |
