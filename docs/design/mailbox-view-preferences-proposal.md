# Columnas por carpeta — propuesta para #36

Estado: **aprobada por el usuario el 2026-10-05**, antes de implementación:
«Aprobar vista general y excepciones por carpeta». Véase ADR 0009.

## Comportamiento propuesto

1. «Columnas» permite mostrar, ordenar y ajustar anchuras mediante controles de
   teclado y ratón. Asunto permanece visible; las casillas de selección quedan
   fuera de esta configuración. Restablecer nunca cambia mensajes ni selección.
2. Una vista general se hereda en todas las carpetas. «Solo esta carpeta» guarda
   una copia independiente; «Usar vista general» elimina esa excepción. Cambiar
   la vista general no sobrescribe carpetas personalizadas.
3. La primera entrega admite remitente, asunto, fecha y cuenta. Solo las tres
   primeras ordenan: utilizan los órdenes completos existentes del núcleo
   (ADR 0003), sin ordenar únicamente la página cargada. Cuenta es informativa.
   Destinatarios, tamaño y otras columnas esperan una semántica fiable de
   conversación; no se inventan valores ni capacidades.
4. Se mantiene el panel actual. Cuando las anchuras elegidas no caben, la tabla
   tiene desplazamiento horizontal propio, con controles accesibles; no ensancha
   toda la aplicación. Restablecer recupera la distribución compacta inicial.

## Contrato de almacenamiento propuesto

Una nueva preferencia `mailbox_views` a través de `app.prefsGet/Set` y la tabla
de ajustes existentes; sin nueva base de datos, servicio ni sincronización remota.
Objeto versionado:

```json
{
  "version": 1,
  "defaultColumns": [
    { "id": "sender", "visible": true, "width": 120 },
    { "id": "subject", "visible": true, "width": "auto" },
    { "id": "date", "visible": true, "width": 80 },
    { "id": "account", "visible": false, "width": 120 }
  ],
  "folders": [
    { "accountId": "existing-account-id", "folderId": "existing-folder-id", "columns": [] }
  ]
}
```

El ejemplo de carpeta muestra la forma; una lista vacía es inválida y se ignora.
El orden del array es el orden visual. Asunto admite `auto`; las anchuras numéricas
se limitan a 64–640 píxeles CSS. Los identificadores son estables, no traducciones.
Una carpeta se identifica por la pareja exacta cuenta/carpeta; la bandeja unificada
usa sus roles actuales. Carpetas distintas nunca comparten una excepción accidental.

Ausencia de la preferencia conserva la vista actual. Se validan versiones, campos,
columnas duplicadas/desconocidas y límites antes de usarlos. Una versión futura no
se sobrescribe automáticamente: la configuración se deshabilita con explicación
hasta que el usuario restablezca expresamente o actualice la aplicación. No se
reescriben preferencias al hidratar. El orden de correo existente sigue separado
de la disposición visual; esta primera entrega no introduce orden por carpeta.

## Entregas y pruebas propuestas

1. Validación/persistencia/herencia con tests de versiones inválidas, claves con
   caracteres especiales, carpetas homónimas, reinicio y ausencia de escrituras
   durante hidratación.
2. Configuración accesible, tabla real y restablecimiento; pruebas claro/oscuro,
   panel estrecho, zoom, teclado, selección y paginación existentes.

La aprobación de esta propuesta permite implementar esas dos entregas dentro de
la arquitectura actual; no autoriza publicación, cambios de proveedores ni nuevas
capacidades de ordenación. #36 seguirá abierta hasta aportar su evidencia completa.
