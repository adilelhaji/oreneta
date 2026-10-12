# Grupos de cuentas (#99, ADR-0040)

## Uso

- **Ajustes → Cuentas → Grupos de cuentas:** crear, renombrar y borrar
  grupos, y elegir sus cuentas. Un nombre vacío o repetido se rechaza.
- **Navegación:** cada grupo aparece debajo de «Bandeja unificada». Al
  elegirlo se ven juntas sus cuentas, con las mismas carpetas unificadas,
  búsqueda, filtros y acciones. «Bandeja unificada» vuelve a todas las
  cuentas incluidas.
- **Barra lateral estrecha:** el menú contextual del botón unificado
  ofrece los grupos.

## Aplicación

`frontend/src/states/accountGroups.ts`:
- `inUnifiedScope` decide qué cuentas entran en la vista unificada, y
  `unifiedAccounts()` la usa;
- se usa también en «marcar todo como leído», en sincronizar y en los
  recuentos;
- `threadListViewKey` incluye el grupo, de modo que cada grupo es su propia
  vista.

## Pruebas

| Nivel | Qué cubre |
|---|---|
| N2 estado (`accountGroups.test.ts`) | Sin grupo, las incluidas; con grupo, exactamente sus cuentas (también una excluida); cada grupo es una vista distinta y no afecta a las vistas de una cuenta; salir de la unificada sale del grupo; nombres obligatorios y únicos; guardado y lectura; datos dañados como «sin grupos»; quitar una cuenta la saca de los grupos; borrar el grupo mostrado vuelve a todas |
| N2 navegación (`MailNavigation.test.tsx`) | Los grupos aparecen bajo la unificada y solo el mostrado está marcado |
| N2 ajustes (`AccountGroupsGroup.test.tsx`) | Crear con las cuentas elegidas; nombre repetido rechazado; borrar pregunta y deja las cuentas |
| N4 pendiente | En Windows, con varias cuentas reales |
