# asistentewhat

Asistente de WhatsApp que junta las cuatro microapps en un solo chat:

| Área | Qué hace por chat |
|---|---|
| Gastos (DuoCash) | "Gasté 400 Bs en mercado" → guarda el gasto con la tasa del día y suma en dólares |
| Vencimientos (VenceYa) | "Netflix 9,99 cada 5" → avisa un día antes y el mismo día |
| Carro (MotorYa) | "Cambié el aceite, 85.000 km, el próximo a los 90.000" → avisa cuando se acerca |
| Medicinas (DosisYa) | "Mamá toma losartán a las 8 y a las 20" → avisa a la hora, "listo" la marca |

Además: resumen cada domingo en la noche, y un **panel web** (el usuario escribe `panel` y recibe un enlace).

Hecho por lacosta.agency.

## Cómo funciona

```
WhatsApp ──► Meta Cloud API ──► /webhook (este servidor) ──► IA (Claude) ──► herramientas ──► SQLite
                                                                                   ▲
                       avisos cada 5 min (vencimientos, medicinas, carro, resumen) ┘
Panel web: /entrar?t=… → cookie → /
Pagos: Lemon Squeezy ──► /pago → plan Pro
```

- `src/servicios.ts`: guardar y consultar datos (sin IA, con pruebas).
- `src/herramientas.ts`: lo que la IA puede hacer con esos datos.
- `src/ia.ts`: instrucciones del asistente y llamada a Claude.
- `src/avisos.ts`: qué avisar y cuándo.
- `src/whatsapp.ts`: enviar y recibir por WhatsApp (texto libre dentro de 24 h, plantilla fuera).
- `src/dashboard.ts`: panel web.
- `src/pagos.ts`: activa el plan Pro con Lemon Squeezy.

Plan gratis: 60 movimientos al mes, 5 vencimientos, 1 vehículo, 3 medicinas. Pro: sin límites.

## Probar en tu computadora

Necesitas Node 22.18 o más nuevo.

```bash
npm install
cp .env.example .env      # pon tu ANTHROPIC_API_KEY
npm test                  # pruebas sin internet
npm run probar            # chatea con el asistente en la terminal, sin WhatsApp
```

## Conectar WhatsApp (número de prueba gratis de Meta)

1. Entra a developers.facebook.com, crea una app tipo **Business** y agrega el producto **WhatsApp**.
2. En *WhatsApp > Configuración de la API* copia el **Phone number ID** y un **token** a `.env`.
   Agrega tu propio número como destinatario de prueba.
3. En *Configuración de la app > Básica* copia la **clave secreta** a `WA_APP_SECRET`.
4. Publica el servidor (abajo) y en *WhatsApp > Configuración > Webhook* pon
   `https://TU-SERVIDOR/webhook` y el mismo `WA_VERIFY_TOKEN`. Suscríbete al campo **messages**.
5. Crea una plantilla de mensaje de categoría **Utilidad** llamada `aviso_general` con el texto
   `{{1}}` (por ejemplo: "Recordatorio: {{1}}"). Se usa para avisos cuando el usuario no ha escrito en 24 horas.

## Publicar el servidor

Cualquier servicio que corra Docker y tenga un disco permanente sirve (Railway, Fly.io, un VPS de 5 USD).
Monta un volumen en `/app/datos` para no perder la base de datos y llena las variables de `.env.example`.
