// Localize the report schedule form (new + edit) and its filter builder.
//
// The prebuilt AppKit form renders English-only labels. BeaconHS now renders
// its own form; every visible string goes through the generated catalogue so
// the browser sees the operator's language. Keys are derived from the English
// source with the same `systemMessageKey` the runtime uses.
//
// Usage: node scripts/ea66d4-29-report-schedule-i18n.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { systemMessageKey } from '../packages/i18n/src/system-key.ts'

/** English source -> [es, fr, zh]. The English source is the catalogue key input. */
const TRANSLATIONS = {
  // Core form
  Report: ['Informe', 'Rapport', '报表'],
  'Schedule name': ['Nombre del programa', 'Nom du programme', '计划名称'],
  Cadence: ['Cadencia', 'Fréquence', '周期'],
  Frequency: ['Frecuencia', 'Fréquence', '频率'],
  Daily: ['Diario', 'Quotidien', '每天'],
  Weekly: ['Semanal', 'Hebdomadaire', '每周'],
  Monthly: ['Mensual', 'Mensuel', '每月'],
  'Repeat every': ['Repetir cada', 'Répéter tous les', '重复间隔'],
  days: ['días', 'jours', '天'],
  weeks: ['semanas', 'semaines', '周'],
  months: ['meses', 'mois', '月'],
  'Day of week': ['Día de la semana', 'Jour de la semaine', '星期'],
  Sunday: ['Domingo', 'Dimanche', '星期日'],
  Monday: ['Lunes', 'Lundi', '星期一'],
  Tuesday: ['Martes', 'Mardi', '星期二'],
  Wednesday: ['Miércoles', 'Mercredi', '星期三'],
  Thursday: ['Jueves', 'Jeudi', '星期四'],
  Friday: ['Viernes', 'Vendredi', '星期五'],
  Saturday: ['Sábado', 'Samedi', '星期六'],
  'Monthly pattern': ['Patrón mensual', 'Modèle mensuel', '每月方式'],
  'Day of month': ['Día del mes', 'Jour du mois', '每月日期'],
  'Weekday of month': ['Día de la semana del mes', 'Jour de la semaine du mois', '每月第几个星期'],
  Week: ['Semana', 'Semaine', '第几周'],
  Weekday: ['Día de la semana', 'Jour de la semaine', '星期几'],
  First: ['Primero', 'Premier', '第一个'],
  Second: ['Segundo', 'Deuxième', '第二个'],
  Third: ['Tercero', 'Troisième', '第三个'],
  Fourth: ['Cuarto', 'Quatrième', '第四个'],
  Last: ['Último', 'Dernier', '最后一个'],
  Time: ['Hora', 'Heure', '时间'],
  Hour: ['Hora', 'Heure', '小时'],
  Minute: ['Minuto', 'Minute', '分钟'],
  Timezone: ['Zona horaria', 'Fuseau horaire', '时区'],
  'Starts on': ['Comienza el', 'Début', '开始日期'],
  'Ends on': ['Termina el', 'Fin', '结束日期'],
  // Recipients
  Recipients: ['Destinatarios', 'Destinataires', '收件人'],
  Members: ['Miembros', 'Membres', '成员'],
  'Add a member': ['Agregar un miembro', 'Ajouter un membre', '添加成员'],
  'Search members': ['Buscar miembros', 'Rechercher des membres', '搜索成员'],
  'Add recipient': ['Agregar destinatario', 'Ajouter un destinataire', '添加收件人'],
  'Remove recipient': ['Quitar destinatario', 'Supprimer le destinataire', '移除收件人'],
  'Additional email addresses': [
    'Direcciones de correo adicionales',
    'Adresses e-mail supplémentaires',
    '其他邮箱地址',
  ],
  'finance@example.com, operations@example.com': [
    'finance@example.com, operations@example.com',
    'finance@example.com, operations@example.com',
    'finance@example.com, operations@example.com',
  ],
  'Separate email addresses with commas or new lines.': [
    'Separe las direcciones de correo con comas o saltos de línea.',
    'Séparez les adresses e-mail par des virgules ou des retours à la ligne.',
    '多个邮箱请用逗号或换行分隔。',
  ],
  // Email copy
  Email: ['Correo', 'E-mail', '邮件'],
  Subject: ['Asunto', 'Objet', '主题'],
  Message: ['Mensaje', 'Message', '正文'],
  'Optional custom subject': [
    'Asunto personalizado opcional',
    'Objet personnalisé facultatif',
    '可选自定义主题',
  ],
  'Optional message above the report attachment': [
    'Mensaje opcional sobre el adjunto del informe',
    'Message facultatif au-dessus de la pièce jointe',
    '报表附件上方的可选说明',
  ],
  // Filters
  'Report filters': ['Filtros del informe', 'Filtres du rapport', '报表筛选'],
  'This report does not expose schedule-time filters.': [
    'Este informe no admite filtros al programar.',
    'Ce rapport n’expose pas de filtres à la planification.',
    '此报表不支持计划运行时筛选。',
  ],
  'All conditions': ['Todas las condiciones', 'Toutes les conditions', '全部条件'],
  'Any condition': ['Cualquier condición', 'Au moins une condition', '任一条件'],
  'Add condition': ['Agregar condición', 'Ajouter une condition', '添加条件'],
  'Add group': ['Agregar grupo', 'Ajouter un groupe', '添加条件组'],
  Remove: ['Quitar', 'Supprimer', '删除'],
  'No conditions.': ['Sin condiciones.', 'Aucune condition.', '暂无筛选条件。'],
  Field: ['Campo', 'Champ', '字段'],
  Operator: ['Operador', 'Opérateur', '运算符'],
  Value: ['Valor', 'Valeur', '值'],
  'Choose a value': ['Elige un valor', 'Choisir une valeur', '选择值'],
  'Type a value': ['Escribe un valor', 'Saisir une valeur', '输入值'],
  'Comma-separated values': [
    'Valores separados por comas',
    'Valeurs séparées par des virgules',
    '用逗号分隔多个值',
  ],
  'One or more email addresses are invalid.': [
    'Una o más direcciones de correo no son válidas.',
    'Une ou plusieurs adresses e-mail sont invalides.',
    '一个或多个邮箱地址无效。',
  ],
  // Operator labels (keyed by the compiler operator key's label)
  is: ['es', 'est', '等于'],
  'is not': ['no es', "n'est pas", '不等于'],
  'is any of': ['es cualquiera de', 'est l’un de', '属于'],
  'is none of': ['no es ninguno de', "n'est aucun de", '不属于'],
  'is at least': ['es al menos', 'est au moins', '大于等于'],
  'is at most': ['es como máximo', 'est au plus', '小于等于'],
  contains: ['contiene', 'contient', '包含'],
  'is empty': ['está vacío', 'est vide', '为空'],
  'is not empty': ['no está vacío', "n'est pas vide", '不为空'],
  'is true': ['es verdadero', 'est vrai', '是'],
  'is false': ['es falso', 'est faux', '否'],
  'is within the last days': [
    'está dentro de los últimos días',
    'est dans les derniers jours',
    '在过去 N 天内',
  ],
  'is due within days': ['vence en días', 'échoit dans les jours', 'N 天内到期'],
  'is today': ['es hoy', "est aujourd'hui", '是今天'],
  'is this week': ['es esta semana', 'est cette semaine', '是本周'],
  'is this month': ['es este mes', 'est ce mois-ci', '是本月'],
  'is this year': ['es este año', 'est cette année', '是本年'],
  'is before now': ['es antes de ahora', 'est avant maintenant', '早于当前时间'],
  'is in period': ['está en el período', 'est dans la période', '在期间内'],
  // Presets
  'This Fiscal Year': ['Este año fiscal', 'Cet exercice fiscal', '本财年'],
  'Fiscal Year to Date': ['Año fiscal hasta la fecha', 'Exercice fiscal à ce jour', '本财年至今'],
  'Last Fiscal Year': ['Último año fiscal', 'Dernier exercice fiscal', '上一财年'],
  'Fiscal Year Before Last': ['Año fiscal antepasado', 'Avant-dernier exercice fiscal', '上上财年'],
  'Next Fiscal Year': ['Próximo año fiscal', 'Prochain exercice fiscal', '下一财年'],
  'Three Fiscal Years Ago': [
    'Hace tres años fiscales',
    'Il y a trois exercices fiscaux',
    '三财年前',
  ],
  'This Fiscal Quarter': ['Este trimestre fiscal', 'Ce trimestre fiscal', '本财季'],
  'Fiscal Quarter to Date': [
    'Trimestre fiscal hasta la fecha',
    'Trimestre fiscal à ce jour',
    '本财季至今',
  ],
  'Last Fiscal Quarter': ['Último trimestre fiscal', 'Dernier trimestre fiscal', '上一财季'],
  'Fiscal Quarter Before Last': [
    'Trimestre fiscal antepasado',
    'Avant-dernier trimestre fiscal',
    '上上财季',
  ],
  'Next Fiscal Quarter': ['Próximo trimestre fiscal', 'Prochain trimestre fiscal', '下一财季'],
  'Three Fiscal Quarters Ago': [
    'Hace tres trimestres fiscales',
    'Il y a trois trimestres fiscaux',
    '三财季前',
  ],
  'Same Fiscal Quarter Last Year': [
    'Mismo trimestre fiscal del año pasado',
    "Même trimestre fiscal l'an dernier",
    '去年同财季',
  ],
  'This Fiscal Half': ['Este semestre fiscal', 'Ce semestre fiscal', '本财半年'],
  'Last Fiscal Half': ['Último semestre fiscal', 'Dernier semestre fiscal', '上一财半年'],
  'Next Fiscal Half': ['Próximo semestre fiscal', 'Prochain semestre fiscal', '下一财半年'],
  'This Period': ['Este período', 'Cette période', '本期'],
  'Period to Date': ['Período hasta la fecha', 'Période à ce jour', '本期至今'],
  'Last Period': ['Último período', 'Dernière période', '上期'],
  'Period Before Last': ['Período antepasado', 'Avant-dernière période', '上上期'],
  'This Month': ['Este mes', 'Ce mois-ci', '本月'],
  'Month to Date': ['Mes hasta la fecha', 'Mois à ce jour', '本月至今'],
  'Last Month': ['Mes pasado', 'Le mois dernier', '上月'],
  'Month Before Last': ['Mes antepasado', "L'avant-dernier mois", '上上月'],
  'Next Month': ['Próximo mes', 'Le mois prochain', '下月'],
  'Same Month Last Fiscal Year': [
    'Mismo mes del año fiscal pasado',
    "Même mois de l'exercice précédent",
    '去年同财月',
  ],
  'This Calendar Year': ['Este año calendario', 'Cette année civile', '本日历年'],
  'Calendar Year to Date': [
    'Año calendario hasta la fecha',
    'Année civile à ce jour',
    '本日历年至今',
  ],
  'Last Calendar Year': ['Último año calendario', 'Dernière année civile', '上一日历年'],
  'Trailing 3 Months': ['Últimos 3 meses', '3 derniers mois', '过去 3 个月'],
  'Trailing 6 Months': ['Últimos 6 meses', '6 derniers mois', '过去 6 个月'],
  'Trailing 12 Months': ['Últimos 12 meses', '12 derniers mois', '过去 12 个月'],
  'Rolling Quarter': ['Trimestre móvil', 'Trimestre glissant', '滚动季度'],
  'Rolling Year': ['Año móvil', 'Année glissante', '滚动年度'],
  Today: ['Hoy', "Aujourd'hui", '今天'],
  Yesterday: ['Ayer', 'Hier', '昨天'],
  Tomorrow: ['Mañana', 'Demain', '明天'],
  'Week to Date': ['Semana hasta la fecha', 'Semaine à ce jour', '本周至今'],
  'Last 7 Days': ['Últimos 7 días', '7 derniers jours', '过去 7 天'],
  'Last 30 Days': ['Últimos 30 días', '30 derniers jours', '过去 30 天'],
  'Last 60 Days': ['Últimos 60 días', '60 derniers jours', '过去 60 天'],
  'Last 90 Days': ['Últimos 90 días', '90 derniers jours', '过去 90 天'],
  'Next 30 Days': ['Próximos 30 días', '30 prochains jours', '未来 30 天'],
  'Custom…': ['Personalizado…', 'Personnalisé…', '自定义…'],
  // Validation and action errors
  'Choose a report.': ['Elige un informe.', 'Choisissez un rapport.', '请选择报表。'],
  'Enter a schedule name.': [
    'Escribe un nombre de programa.',
    'Saisissez un nom de programme.',
    '请输入计划名称。',
  ],
  'Name is too long.': ['El nombre es demasiado largo.', 'Le nom est trop long.', '名称过长。'],
  'Repeat interval must be a whole number between 1 and 999.': [
    'El intervalo debe ser un número entero entre 1 y 999.',
    "L'intervalle doit être un nombre entier entre 1 et 999.",
    '重复间隔必须是 1–999 的整数。',
  ],
  'Hour must be between 0 and 23.': [
    'La hora debe estar entre 0 y 23.',
    "L'heure doit être comprise entre 0 et 23.",
    '小时必须是 0–23。',
  ],
  'Minute must be between 0 and 59.': [
    'El minuto debe estar entre 0 y 59.',
    'La minute doit être comprise entre 0 et 59.',
    '分钟必须是 0–59。',
  ],
  'Day of month must be between 1 and 31.': [
    'El día del mes debe estar entre 1 y 31.',
    'Le jour du mois doit être compris entre 1 et 31.',
    '每月日期必须是 1–31。',
  ],
  'Start date must be on or before end date.': [
    'La fecha de inicio debe ser anterior o igual a la de fin.',
    'La date de début doit être antérieure ou égale à la date de fin.',
    '开始日期不能晚于结束日期。',
  ],
  'Unknown timezone. Use an IANA timezone name.': [
    'Zona horaria desconocida. Usa un nombre de zona horaria IANA.',
    'Fuseau horaire inconnu. Utilisez un nom de fuseau IANA.',
    '时区无效，请使用 IANA 时区名称。',
  ],
  'The schedule could not be saved.': [
    'No se pudo guardar el programa.',
    "Le programme n'a pas pu être enregistré.",
    '计划保存失败。',
  ],
  'Schedule not found.': ['Horario no encontrado.', 'Calendrier non trouvé.', '未找到计划。'],
  'Choose an available report.': [
    'Elige un informe disponible.',
    'Choisissez un rapport disponible.',
    '请选择一个可用的报表。',
  ],
  'An active tenant membership is required.': [
    'Se requiere una membresía activa del espacio de trabajo.',
    'Une adhésion active à l’espace de travail est requise.',
    '需要有效的租户成员身份。',
  ],
}

const LOCALES = ['en', 'es', 'fr', 'zh']
const base = new URL('../packages/i18n/src/messages/', import.meta.url)
const checkOnly = process.argv.includes('--check')

let written = 0
let unchanged = 0
const kept = []

for (const [source, values] of Object.entries(TRANSLATIONS)) {
  const key = systemMessageKey(source)
  ;[source, ...values].forEach((translation, index) => {
    const locale = LOCALES[index]
    const file = new URL(`${locale}.json`, base)
    const catalogue = JSON.parse(readFileSync(file, 'utf8'))
    catalogue.Generated ??= {}
    const existing = catalogue.Generated[key]
    if (existing !== undefined) {
      if (existing !== translation) {
        // Existing catalogue copy wins — it is already shown elsewhere in the app.
        kept.push(`${source} [${locale}]`)
      } else {
        unchanged += 1
      }
      return
    }
    if (!checkOnly) {
      catalogue.Generated[key] = translation
      writeFileSync(file, `${JSON.stringify(catalogue, null, 2)}\n`)
    }
    written += 1
  })
}

console.log(
  checkOnly
    ? `checked ${Object.keys(TRANSLATIONS).length} sources; ${written} missing entries`
    : `added ${written} entries (${unchanged} already correct, ${kept.length} kept existing)`,
)
