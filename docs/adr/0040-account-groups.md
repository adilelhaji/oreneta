# ADR-0040: Grupos de cuentas

- Estado: aceptada por delegación («Tomo yo la recomendada»); pendiente de
  revisión del propietario al final del plan.
- Fecha: 2026-10-12.
- Alcance: #99 (la parte de grupos de cuentas; los perfiles son ADR-0016).

## Decisión

- **Qué es un grupo:** un nombre y las cuentas que la persona elige. Es una
  vista: no mueve, copia ni guarda correo, y una cuenta puede estar en
  varios grupos.
- **Cómo se ve:** a través de la bandeja unificada, limitada a las cuentas
  del grupo. Los grupos aparecen debajo de «Bandeja unificada» en la
  navegación de cuentas y en el menú contextual del botón unificado de la
  barra lateral.
- **Inclusión explícita:**
  - un grupo muestra exactamente las cuentas que nombra, aunque alguna esté
    excluida de la bandeja unificada general;
  - la bandeja unificada sin grupo sigue mostrando las cuentas incluidas,
    como antes.
- **Vistas separadas:** cada grupo es una vista distinta de la lista, así
  que una lista cargada para un grupo no se muestra para otro.
- **Al salir de la vista unificada** se sale también del grupo.
- **Guardado:** en las preferencias del perfil (`account_groups`). Viaja con
  la copia completa del perfil y no se sincroniza con ningún servidor.
- **Consistencia:**
  - quitar una cuenta la saca de todos los grupos;
  - borrar un grupo no toca sus cuentas;
  - los datos dañados se leen como «sin grupos», sin romper la vista.

## Alternativas descartadas

- **Carpetas globales por grupo en el núcleo:** la vista unificada ya se
  compone en la aplicación cuenta a cuenta, así que basta con limitar qué
  cuentas entran.
- **Una cuenta en un solo grupo:** obliga a elegir entre, por ejemplo,
  «Trabajo» y «Todo lo de Ana». Una vista no necesita esa exclusión.
