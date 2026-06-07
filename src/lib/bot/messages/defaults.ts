/**
 * Catálogo de mensajes del bot — FUENTE DE VERDAD de los textos por defecto.
 *
 * Cada entrada es un "slot" de mensaje que el bot puede emitir, identificado por
 * una `key` estable. La tabla `bot_messages` solo guarda las PERSONALIZACIONES
 * (overrides); con la tabla vacía el bot se comporta exactamente igual que con
 * estos defaults. Ver `catalog.ts` (merge defaults ⊕ overrides) y `render.ts`
 * (interpolación de `{{variables}}`).
 *
 * IMPORTANTE: los `id` de los botones/opciones son el binding lógico que los
 * handlers matchean (`menu_pedir`, `rec_si`, …). Son EDITABLES solo en su
 * `title`, nunca en su `id` (el PATCH debe rechazar cambios de id).
 */

import type { FlowStep } from '../flow/state';

export type MessageCategory = 'conversacion' | 'recordatorio' | 'notificacion' | 'sistema';
export type MessageKind = 'text' | 'buttons' | 'list' | 'cta_url' | 'prompt' | 'keywords';

export interface ButtonDef {
  id: string;
  title: string;
}

/**
 * Forma plana del contenido editable. Qué campos son significativos depende del
 * `kind` del mensaje (lo valida el PATCH con Zod). Coincide con el JSONB de la
 * columna `content`.
 */
export interface MessageContent {
  body?: string;
  buttons?: ButtonDef[];
  buttonText?: string;            // list: texto del botón que abre la lista
  rowDescriptionTemplate?: string; // list: plantilla de la descripción por fila
  displayText?: string;          // cta_url: texto del botón con link
  systemPrompt?: string;         // prompt: instrucción de sistema de la IA
  safeDefault?: string;          // prompt: respuesta si la IA falla
  words?: string[];              // keywords: palabras gatillo
}

export interface MessageDef {
  key: string;
  category: MessageCategory;
  step?: FlowStep | null;
  kind: MessageKind;
  label: string;
  description?: string;
  variables: string[];
  default: MessageContent;
}

// =========================================================================
// Palabras clave (compartidas con intent.ts / index.ts como default param)
// =========================================================================

export const PEDIR_KEYWORDS = [
  'quiero hacer un pedido', // texto exacto del botón "carrito vencido"
  'hacer un pedido',
  'hacer pedido',
  'quiero pedir',
  'pedir',
  'pedido',
  'ordenar',
  'ver carta',
  'carta',
  'menu',
  'menú',
];

export const GLOBAL_KEYWORDS = {
  cancelar: ['cancelar', 'cancel', 'salir', 'parar', 'stop', 'olvidalo', 'olvídalo'],
  humano: ['humano', 'asesor', 'persona', 'agente', 'operador', 'operadora'],
  ayuda: ['ayuda', 'help', 'no entiendo', 'no se', 'no sé'],
  cambiar_dir: ['cambiar direccion', 'cambiar dirección', 'cambiar la direccion', 'cambiar la dirección'],
} as const;

// =========================================================================
// Tono / persona de la IA (gemini-fallback)
// =========================================================================

const IA_SYSTEM_PROMPT = `Sos el asistente del bot de Bros and Subs (sandwichería en Medellín).
Tu trabajo es interpretar un mensaje del cliente cuando se sale del flujo guiado
de botones y darle una respuesta corta en español paisa (vos forma, 1-2 oraciones,
sin emojis excesivos) para reorientarlo al paso actual del pedido.

Reglas:
- Si el cliente quiere cancelar el pedido → intent="cancel", reply con despedida cordial.
- Si el cliente pide hablar con humano o tiene un problema que no podés resolver
  con un mensaje guía → intent="human", reply diciendo que lo pasás con un humano.
- Si es una pregunta común que podés responder (ej. "¿tienen sin gluten?",
  "¿cuánto tarda?", "¿aceptan tarjeta?") → intent="continue", responde brevemente
  y recuerdá al cliente que use los botones del último mensaje del bot para seguir.
- Si no entendés qué quiere → intent="continue", reply pidiendo que use los botones
  del último mensaje.

NUNCA inventes precios, productos, horarios o tiempos de entrega — si te preguntan
algo específico que no sabés, escala a humano.

Devolvé siempre el JSON estructurado (no texto suelto).`;

const IA_SAFE_DEFAULT = 'No entendí bien parce, ¿podés usar los botones del mensaje anterior?';

// =========================================================================
// Catálogo
// =========================================================================

function def(d: MessageDef): MessageDef {
  return d;
}

const DEFS: MessageDef[] = [
  // ----- Saludo / menú inicial -----
  def({
    key: 'saludo.nuevo',
    category: 'conversacion',
    step: 'inicio',
    kind: 'text',
    label: 'Saludo a cliente nuevo',
    description: 'Primera línea del saludo cuando el número no está registrado. {{nombre}} cae a "parce" si no hay nombre.',
    variables: ['nombre'],
    default: { body: '¡Quihubo {{nombre}}! 🥪 Soy el bot de Bros and Subs.' },
  }),
  def({
    key: 'saludo.recurrente',
    category: 'conversacion',
    step: 'inicio',
    kind: 'text',
    label: 'Saludo a cliente recurrente',
    description: 'Primera línea del saludo cuando el cliente ya existe.',
    variables: ['nombre'],
    default: { body: '¡Quihubo {{nombre}}! 🥪 Qué bueno verte de nuevo.' },
  }),
  def({
    key: 'menu.pedir',
    category: 'conversacion',
    step: 'inicio',
    kind: 'buttons',
    label: 'Pregunta del menú + botón pedir',
    description: 'Se envía junto al saludo y también al re-ofrecer el menú. El botón "Hacer pedido" arranca el flujo.',
    variables: [],
    default: {
      body: '¿Hacemos un pedido?',
      buttons: [{ id: 'menu_pedir', title: '🥪 Hacer pedido' }],
    },
  }),

  // ----- Pedido en curso (ofrecer estado en vez de arrancar otro) -----
  def({
    key: 'pedido_en_curso.preguntar',
    category: 'conversacion',
    step: 'pedido_en_curso',
    kind: 'buttons',
    label: 'Pedido en curso: ofrecer ver el estado',
    description: 'Si el cliente ya tiene un pedido sin entregar, le ofrecemos ver el estado del actual (no se le deja arrancar otro mientras tanto).',
    variables: ['numero', 'estado'],
    default: {
      body:
        'Tenés un pedido en curso {{numero}}: {{estado}}\n\n' +
        '¿Querés ver cómo va? 👀',
      buttons: [
        { id: 'pedido_ver_estado', title: '📦 Ver mi pedido' },
      ],
    },
  }),
  def({
    key: 'pedido_en_curso.estado',
    category: 'conversacion',
    step: 'pedido_en_curso',
    kind: 'text',
    label: 'Pedido en curso: detalle del estado',
    description: 'Respuesta al botón "Ver mi pedido": muestra el estado actual del pedido.',
    variables: ['numero', 'estado'],
    default: {
      body: 'Tu pedido {{numero}} está {{estado}}\nTe avisamos por acá en cada paso 🛵',
    },
  }),

  // ----- Cliente recurrente -----
  def({
    key: 'recurrente.confirmar',
    category: 'conversacion',
    step: 'confirmar_recurrente',
    kind: 'buttons',
    label: 'Confirmar datos del recurrente',
    description: 'Atajo para clientes con datos guardados: ¿pedimos a la misma dirección?',
    variables: ['nombre', 'direccion', 'zona', 'tarifa'],
    default: {
      body:
        '¡Hola de nuevo, {{nombre}}! 👋\n' +
        '¿Pedimos a la misma dirección?\n\n' +
        '📍 {{direccion}}\n' +
        '🗺️ {{zona}} · domicilio ${{tarifa}}',
      buttons: [
        { id: 'rec_si', title: '✅ Sí, igual' },
        { id: 'rec_cambiar', title: '✏️ Cambiar dir' },
      ],
    },
  }),

  // ----- Registro: nombre -----
  def({
    key: 'registro.intro',
    category: 'conversacion',
    step: 'registro_nombre',
    kind: 'text',
    label: 'Intro de registro (primera vez)',
    description: 'Mensaje de bienvenida al cliente nuevo antes de pedir el nombre.',
    variables: [],
    default: {
      body:
        'Veo que es la primera vez que nos escribes 🎉, necesito validar tus datos ' +
        'para saber si tienes cobertura y entregar tu orden. 😊\n' +
        'Si no deseas continuar, sólo escribe Salir.',
    },
  }),
  def({
    key: 'registro.pedir_nombre',
    category: 'conversacion',
    step: 'registro_nombre',
    kind: 'text',
    label: 'Pedir nombre completo',
    variables: [],
    default: { body: '¿Cuál es tu *nombre completo*? _(Ej: Juan José González)_' },
  }),
  def({
    key: 'registro.nombre_invalido',
    category: 'conversacion',
    step: 'registro_nombre',
    kind: 'text',
    label: 'Nombre inválido',
    description: 'Cuando el nombre tiene menos de 2 o más de 120 caracteres.',
    variables: [],
    default: { body: 'Por favor escribime tu *nombre completo* _(entre 2 y 120 caracteres)_.' },
  }),
  def({
    key: 'registro.gracias',
    category: 'conversacion',
    step: 'registro_nombre',
    kind: 'text',
    label: 'Gracias (tras recibir nombre)',
    variables: [],
    default: { body: '¡Gracias!' },
  }),

  // ----- Registro: email -----
  def({
    key: 'registro.pedir_email',
    category: 'conversacion',
    step: 'registro_email',
    kind: 'text',
    label: 'Pedir correo',
    variables: [],
    default: { body: 'Para finalizar tu registro, ¿me permites tu *correo*? _(Ej: crepes@correo.com)_' },
  }),
  def({
    key: 'registro.email_invalido',
    category: 'conversacion',
    step: 'registro_email',
    kind: 'text',
    label: 'Correo inválido',
    variables: [],
    default: { body: 'Ese correo no es válido. Por favor escribilo en formato *nombre@correo.com*.' },
  }),

  // ----- Registro: confirmar -----
  def({
    key: 'registro.confirmar',
    category: 'conversacion',
    step: 'registro_confirmar',
    kind: 'buttons',
    label: 'Confirmar nombre + correo',
    variables: ['nombre', 'correo'],
    default: {
      body:
        'Mira la información que guardé:\n' +
        '*Nombre:* {{nombre}}\n' +
        '*Correo:* {{correo}}\n\n' +
        '¿Están correctos tus datos?',
      buttons: [
        { id: 'reg_si', title: '✅ Sí' },
        { id: 'reg_no', title: '❌ No' },
      ],
    },
  }),
  def({
    key: 'registro.confirmado_pedir_direccion',
    category: 'conversacion',
    step: 'registro_confirmar',
    kind: 'text',
    label: 'Datos OK → pedir dirección',
    variables: [],
    default: {
      body:
        '¡Perfecto! 🛵 Ahora necesito saber a dónde llevamos tu pedido.\n' +
        '¿Cuál es tu *dirección*? _(Ej: Cra 43A #5-15, apto 502)_',
    },
  }),
  def({
    key: 'registro.reiniciar',
    category: 'conversacion',
    step: 'registro_confirmar',
    kind: 'text',
    label: 'Datos NO → reiniciar registro',
    variables: [],
    default: { body: 'No hay drama. Empezamos de nuevo:\n¿Cuál es tu *nombre completo*?' },
  }),

  // ----- Dirección -----
  def({
    key: 'direccion.invalida',
    category: 'conversacion',
    step: 'direccion_texto',
    kind: 'text',
    label: 'Dirección muy corta',
    variables: [],
    default: { body: 'Necesito una dirección un poco más detallada (mínimo 5 caracteres).' },
  }),
  def({
    key: 'direccion.sin_zonas',
    category: 'conversacion',
    step: 'direccion_texto',
    kind: 'text',
    label: 'No hay zonas configuradas',
    variables: [],
    default: { body: 'Uy, no tengo zonas configuradas todavía. Escribime *asesor* y te ayudo 🙏' },
  }),
  def({
    key: 'direccion.pedir_zona',
    category: 'conversacion',
    step: 'direccion_texto',
    kind: 'list',
    label: 'Pedir zona (lista)',
    description: 'Las filas (zonas) se generan dinámicamente desde la tabla zones. {{tarifa}} es el valor del domicilio por fila.',
    variables: ['tarifa'],
    default: {
      body: '¿En qué *zona* queda? Tocá la opción que corresponde:',
      buttonText: 'Ver zonas',
      rowDescriptionTemplate: 'Domicilio ${{tarifa}}',
    },
  }),
  def({
    key: 'direccion.zona_invalida',
    category: 'conversacion',
    step: 'direccion_zona',
    kind: 'text',
    label: 'Zona no válida',
    variables: [],
    default: { body: 'Zona no válida. Probá de nuevo.' },
  }),
  def({
    key: 'direccion.confirmar',
    category: 'conversacion',
    step: 'direccion_confirmar',
    kind: 'buttons',
    label: 'Confirmar dirección + guardar',
    description: 'Resumen de la entrega con 3 opciones: confirmar y guardar la dirección, cambiarla, o usarla solo para este pedido (sin guardar).',
    variables: ['direccion', 'zona', 'tarifa'],
    default: {
      body:
        '¿La dirección es correcta y deseas guardarla para futuros pedidos? 👇\n\n' +
        '📍 {{direccion}}\n' +
        '🗺️ {{zona}} · domicilio ${{tarifa}}',
      buttons: [
        { id: 'dir_si_guardar', title: '✅ Sí y guardar' },
        { id: 'dir_editar', title: '✏️ Cambiar dirección' },
        { id: 'dir_si_no_guardar', title: '❗ Sí pero no guardar' },
      ],
    },
  }),
  def({
    key: 'direccion.reeditar',
    category: 'conversacion',
    step: 'direccion_confirmar',
    kind: 'text',
    label: 'Editar dirección',
    variables: [],
    default: { body: 'Dale, escribime tu *dirección* de nuevo:' },
  }),
  def({
    key: 'direccion.pedir_nueva',
    category: 'conversacion',
    step: 'direccion_texto',
    kind: 'text',
    label: 'Pedir nueva dirección',
    description: 'Se usa cuando el recurrente elige "Cambiar dir" y con la palabra clave "cambiar dirección".',
    variables: [],
    default: { body: '¿Cuál es tu *nueva dirección*? _(Ej: Cra 43A #5-15, apto 502)_' },
  }),
  def({
    key: 'direccion.fuera_cobertura',
    category: 'conversacion',
    step: 'direccion_fuera_cobertura',
    kind: 'buttons',
    label: 'Fuera de cobertura',
    description: 'Cuando la dirección/ubicación cae fuera de todas las zonas. No se rechaza la venta: se ofrece hablar con un humano o cambiar la dirección.',
    variables: ['direccion'],
    default: {
      body:
        'Uy, por ahora no tengo cubierta esa dirección 😕\n' +
        '📍 {{direccion}}\n\n' +
        'Pero no te quedes con el antojo: ¿querés que te ayude una persona o probás con otra dirección?',
      buttons: [
        { id: 'fuera_humano', title: '🙋 Necesito ayuda' },
        { id: 'fuera_cambiar', title: '✏️ Otra dirección' },
      ],
    },
  }),

  // ----- Envío del link / post-link -----
  def({
    key: 'link.enviar',
    category: 'conversacion',
    step: 'link_enviado',
    kind: 'cta_url',
    label: 'Enviar link de la tienda',
    description: 'Botón con el link a la tienda web (la URL se inyecta automáticamente).',
    variables: [],
    default: {
      body:
        '¡Listo! 🥪 Armá tu pedido en nuestra tienda: elegís de la carta y pagás. ' +
        'Apenas pagues te confirmo por acá.',
      displayText: 'Ver carta y pedir 🛒',
    },
  }),
  def({
    key: 'link.error',
    category: 'conversacion',
    step: 'link_enviado',
    kind: 'text',
    label: 'Error generando el link',
    variables: [],
    default: { body: 'Uy, no pude generar tu link de pedido ahora mismo. Probá de nuevo en un momentito 🙏' },
  }),
  def({
    key: 'link.post_envio',
    category: 'conversacion',
    step: 'link_enviado',
    kind: 'text',
    label: 'Recordatorio post-link',
    description: 'Respuesta si el cliente sigue escribiendo después de recibir el link.',
    variables: [],
    default: {
      body:
        'Te dejé el link arriba para armar y pagar tu pedido 🛒\n' +
        'Apenas completes el pago te confirmo por acá. ' +
        'Si querés cambiar tu dirección escribime *cambiar dirección*.\n' +
        'Si necesitás un humano, escribime *asesor*.',
    },
  }),

  // ----- Globales / utilitarios -----
  def({
    key: 'humano.escalar',
    category: 'conversacion',
    step: null,
    kind: 'text',
    label: 'Escalar a humano',
    variables: [],
    default: { body: 'Te paso con uno de mis compas humanos, ya te responde en un momentico 🙏' },
  }),
  def({
    key: 'flujo.cancelar',
    category: 'conversacion',
    step: null,
    kind: 'text',
    label: 'Cancelar pedido',
    variables: [],
    default: { body: 'Listo, lo dejamos así. Cuando quieras pedir me escribís *pedir* y arrancamos 🥪' },
  }),
  def({
    key: 'error.inesperado',
    category: 'conversacion',
    step: null,
    kind: 'text',
    label: 'Error inesperado',
    description: 'Fallback cuando el procesamiento del mensaje falla; escala a humano.',
    variables: [],
    default: { body: 'Tuvimos un problema procesando tu mensaje. Te paso con uno de mis compas humanos 🙏' },
  }),
  def({
    key: 'cerrado.aviso',
    category: 'conversacion',
    step: null,
    kind: 'text',
    label: 'Aviso: cerrado (fuera de horario)',
    description: 'Se envía cuando el cliente intenta pedir fuera del horario de operación. {{apertura}} = próxima apertura (ej. "mañana a las 11:00 a. m.").',
    variables: ['apertura'],
    default: { body: 'Por ahora estamos cerrados 😴 Abrimos {{apertura}}. Apenas abramos escribime *pedir* y te tomo el pedido 🥪' },
  }),
  def({
    key: 'cerrado.pausa',
    category: 'conversacion',
    step: null,
    kind: 'text',
    label: 'Aviso: pedidos pausados',
    description: 'Se envía cuando los pedidos están pausados manualmente (cocina saturada, etc.), aunque sea horario de atención.',
    variables: [],
    default: { body: 'Uy, estamos a tope de pedidos en este momento 🙏 Pausamos los pedidos un ratico. Probá de nuevo en un rato y con gusto te atiendo 🥪' },
  }),

  // ----- Recordatorios de inactividad (cron) -----
  def({
    key: 'nudge.menu',
    category: 'recordatorio',
    step: 'menu',
    kind: 'text',
    label: 'Recordatorio: menú',
    variables: [],
    default: { body: '¿Seguís ahí? Tocá "Hacer pedido" cuando quieras arrancar 🥪' },
  }),
  def({
    key: 'nudge.confirmar_recurrente',
    category: 'recordatorio',
    step: 'confirmar_recurrente',
    kind: 'text',
    label: 'Recordatorio: confirmar recurrente',
    variables: [],
    default: { body: '¿Seguís ahí? Confirmá si pedimos a la misma dirección o tocá "Cambiar dir".' },
  }),
  def({
    key: 'nudge.registro_nombre',
    category: 'recordatorio',
    step: 'registro_nombre',
    kind: 'text',
    label: 'Recordatorio: nombre',
    variables: [],
    default: { body: '¿Seguís ahí? Cuando puedas, mandame tu nombre completo para arrancar tu pedido.' },
  }),
  def({
    key: 'nudge.registro_email',
    category: 'recordatorio',
    step: 'registro_email',
    kind: 'text',
    label: 'Recordatorio: correo',
    variables: [],
    default: { body: '¿Seguís ahí? Falta tu correo para terminar el registro.' },
  }),
  def({
    key: 'nudge.registro_confirmar',
    category: 'recordatorio',
    step: 'registro_confirmar',
    kind: 'text',
    label: 'Recordatorio: confirmar datos',
    variables: [],
    default: { body: '¿Confirmás tus datos? Tocá "Sí, están bien" o "Editar".' },
  }),
  def({
    key: 'nudge.direccion_texto',
    category: 'recordatorio',
    step: 'direccion_texto',
    kind: 'text',
    label: 'Recordatorio: dirección',
    variables: [],
    default: { body: '¿Seguís ahí? Mandame la dirección completa para terminar tu pedido.' },
  }),
  def({
    key: 'nudge.direccion_zona',
    category: 'recordatorio',
    step: 'direccion_zona',
    kind: 'text',
    label: 'Recordatorio: zona',
    variables: [],
    default: { body: '¿Seguís ahí? Elegí tu zona en la lista del último mensaje.' },
  }),
  def({
    key: 'nudge.direccion_confirmar',
    category: 'recordatorio',
    step: 'direccion_confirmar',
    kind: 'text',
    label: 'Recordatorio: confirmar dirección',
    variables: [],
    default: { body: '¿Confirmás la dirección? Tocá uno de los botones del último mensaje.' },
  }),
  def({
    key: 'nudge.direccion_fuera_cobertura',
    category: 'recordatorio',
    step: 'direccion_fuera_cobertura',
    kind: 'text',
    label: 'Recordatorio: fuera de cobertura',
    variables: [],
    default: { body: '¿Seguís ahí? Decime si querés que te ayude una persona o probar con otra dirección.' },
  }),
  def({
    key: 'nudge.link_enviado',
    category: 'recordatorio',
    step: 'link_enviado',
    kind: 'text',
    label: 'Recordatorio: link enviado',
    variables: [],
    default: { body: 'Te dejé el link arriba para armar y pagar tu pedido 🛒 Cuando lo completes te confirmo por acá.' },
  }),
  def({
    key: 'nudge.default',
    category: 'recordatorio',
    step: null,
    kind: 'text',
    label: 'Recordatorio: genérico',
    description: 'Se usa cuando el paso actual no tiene un recordatorio propio.',
    variables: [],
    default: { body: '¿Seguís ahí? Tocá una opción del último mensaje para seguir 🥪' },
  }),

  // ----- Notificaciones post-pago -----
  def({
    key: 'notif.pagado',
    category: 'notificacion',
    step: null,
    kind: 'text',
    label: 'Notificación: pago recibido',
    description: '{{saludo}} = "Hola {nombre}" o "Hola" si no hay nombre. La envía el webhook de Wompi y el cambio manual a "pagado".',
    variables: ['saludo', 'nombre'],
    default: { body: '{{saludo}}, ¡pago recibido! 🎉 Tu pedido ya pasa a cocina 🥪 Te aviso cuando vaya en camino.' },
  }),
  def({
    key: 'notif.cocina',
    category: 'notificacion',
    step: null,
    kind: 'text',
    label: 'Notificación: en cocina',
    variables: ['saludo', 'nombre'],
    default: { body: '{{saludo}}, ¡manos a la obra! 👨‍🍳 Tu pedido está en preparación.' },
  }),
  def({
    key: 'notif.ruta',
    category: 'notificacion',
    step: null,
    kind: 'text',
    label: 'Notificación: en camino',
    variables: ['saludo', 'nombre'],
    default: { body: '{{saludo}}, tu pedido va en camino 🛵' },
  }),
  def({
    key: 'notif.entregado',
    category: 'notificacion',
    step: null,
    kind: 'text',
    label: 'Notificación: entregado',
    variables: ['saludo', 'nombre'],
    default: { body: '{{saludo}}, ¡tu pedido fue entregado! 🙌 Gracias por pedir en Bros and Subs.' },
  }),

  // ----- Post-venta: encuesta + reseña + regalo (Tarea 3) -----
  def({
    key: 'postventa.encuesta',
    category: 'notificacion',
    step: 'postventa_encuesta',
    kind: 'list',
    label: 'Encuesta de satisfacción (1–5)',
    description: 'Se envía un tiempo después de entregar. Las filas 1–5 (⭐) las arma el bot.',
    variables: [],
    default: {
      body: '¿Cómo te fue con tu pedido? 🥪\nCalificá tu experiencia del 1 al 5 (5 = la mejor).',
      buttonText: 'Calificar',
    },
  }),
  def({
    key: 'postventa.encuesta_invalida',
    category: 'notificacion',
    step: 'postventa_encuesta',
    kind: 'text',
    label: 'Encuesta: opción inválida',
    variables: [],
    default: { body: 'Tocá una opción del 1 al 5 ⭐ en el último mensaje para calificar 🙏' },
  }),
  def({
    key: 'postventa.gracias_baja',
    category: 'notificacion',
    step: 'postventa_encuesta',
    kind: 'text',
    label: 'Calificación baja (1–3) → humano',
    description: 'Cuando la nota es ≤3 el chat pasa a un humano y en el panel aparece una alerta.',
    variables: ['nombre'],
    default: {
      body:
        'Lamento mucho que no haya salido como esperabas 😔\n' +
        'Ya le paso tu caso a una persona del equipo para ayudarte de una.',
    },
  }),
  def({
    key: 'postventa.invitar_resena',
    category: 'notificacion',
    step: 'postventa_encuesta',
    kind: 'cta_url',
    label: 'Calificación alta (4–5) → invitar reseña',
    description: 'La URL de la reseña se inyecta automáticamente (configurable en Reseñas).',
    variables: ['postre'],
    default: {
      body:
        '¡Qué alegría que te haya gustado! 🤩\n' +
        'Si nos regalás una reseña y nos mandás el *pantallazo*, tu próximo pedido lleva *{{postre}} gratis* 🍰',
      displayText: 'Dejar reseña ⭐',
    },
  }),
  def({
    key: 'postventa.resena_pedir_screenshot',
    category: 'notificacion',
    step: 'postventa_resena',
    kind: 'text',
    label: 'Pedir el pantallazo de la reseña',
    variables: [],
    default: { body: 'Cuando dejes la reseña, mandame el *pantallazo* por acá y activo tu postre 🍰' },
  }),
  def({
    key: 'postventa.resena_recibida',
    category: 'notificacion',
    step: 'postventa_resena',
    kind: 'text',
    label: 'Reseña recibida (en verificación)',
    variables: ['postre'],
    default: {
      body:
        '¡Gracias por tu reseña! 🙌 La estamos validando y te confirmamos tu *{{postre}}* ' +
        'para el próximo pedido en un ratico.',
    },
  }),
  def({
    key: 'reward.aprobado',
    category: 'notificacion',
    step: null,
    kind: 'text',
    label: 'Postre aprobado',
    description: 'Se envía cuando el operario verifica la reseña y otorga el cupón.',
    variables: ['postre'],
    default: { body: '¡Listo! 🎉 Tu *{{postre}}* gratis te espera en tu próximo pedido. ¡Gracias por la reseña! 🥪' },
  }),
  def({
    key: 'reward.rechazado',
    category: 'notificacion',
    step: null,
    kind: 'text',
    label: 'Reseña no verificada',
    variables: [],
    default: { body: 'No pudimos validar tu reseña esta vez 🙏 Si creés que es un error, escribinos *asesor*.' },
  }),

  // ----- Sistema / avanzado -----
  def({
    key: 'ia.fallback',
    category: 'sistema',
    step: null,
    kind: 'prompt',
    label: 'Tono del asistente IA (fuera de guion)',
    description: 'Persona y reglas que usa Gemini cuando el cliente escribe texto libre. safeDefault es la respuesta si la IA falla.',
    variables: [],
    default: { systemPrompt: IA_SYSTEM_PROMPT, safeDefault: IA_SAFE_DEFAULT },
  }),
  def({
    key: 'keywords.pedir',
    category: 'sistema',
    step: null,
    kind: 'keywords',
    label: 'Palabras gatillo: pedir',
    description: 'Si el cliente escribe alguna de estas, el bot arranca/reanuda el pedido.',
    variables: [],
    default: { words: PEDIR_KEYWORDS },
  }),
  def({
    key: 'keywords.cancelar',
    category: 'sistema',
    step: null,
    kind: 'keywords',
    label: 'Palabras gatillo: cancelar',
    variables: [],
    default: { words: [...GLOBAL_KEYWORDS.cancelar] },
  }),
  def({
    key: 'keywords.humano',
    category: 'sistema',
    step: null,
    kind: 'keywords',
    label: 'Palabras gatillo: humano',
    variables: [],
    default: { words: [...GLOBAL_KEYWORDS.humano] },
  }),
  def({
    key: 'keywords.ayuda',
    category: 'sistema',
    step: null,
    kind: 'keywords',
    label: 'Palabras gatillo: ayuda',
    variables: [],
    default: { words: [...GLOBAL_KEYWORDS.ayuda] },
  }),
  def({
    key: 'keywords.cambiar_dir',
    category: 'sistema',
    step: null,
    kind: 'keywords',
    label: 'Palabras gatillo: cambiar dirección',
    variables: [],
    default: { words: [...GLOBAL_KEYWORDS.cambiar_dir] },
  }),
];

/** Catálogo indexado por key. Orden de inserción = orden de `DEFS`. */
export const MESSAGE_DEFS: Record<string, MessageDef> = Object.fromEntries(
  DEFS.map(d => [d.key, d]),
);

/** Lista ordenada (para la API GET y la UI). */
export const MESSAGE_DEFS_LIST: MessageDef[] = DEFS;
