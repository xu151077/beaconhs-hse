// The first-run setup copy: its source strings, its catalogue keys, and the
// translation of each string in the four locales.
//
// WHY THIS IS A SCRIPT AND NOT A JSON BLOB
// ----------------------------------------
// The page references its copy by catalogue KEY (`m_<14 hex>`), and the key is
// derived from the source string with `systemMessageKey` — the same function
// `@beaconhs/i18n/key` uses at runtime. A key written by hand can drift from
// the string it was derived from, and the drift is invisible until the page
// renders the wrong copy in one locale.
//
// So the source strings live HERE, next to their translations, and this script
// derives the keys and writes the catalogues. Running it again is idempotent:
// a key that already holds a value is left alone, and a key that holds a
// DIFFERENT value is reported rather than overwritten.
//
// The page copy is authored in Chinese (the product's source locale), so its
// key is derived from the Chinese text. An action outcome describes a machine
// condition, so its key is derived from the English text.
//
// Usage:
//   node scripts/ea66d3-0-setup-copy.mjs          # write the catalogue entries
//   node scripts/ea66d3-0-setup-copy.mjs --check  # verify only, write nothing
import { readFileSync, writeFileSync } from 'node:fs'
import { systemMessageKey } from '../packages/i18n/src/system-key.ts'

const LOCALES = ['en', 'es', 'fr', 'zh']

/** Page prose: [en, es, fr, zh]; the key is derived from the zh value. */
const PAGE_COPY = {
  pageTitle: [
    'System setup',
    'Configuración del sistema',
    'Configuration du système',
    '系统初始化',
  ],
  pageSubtitle: [
    'Complete the first-time setup: create the platform administrator, configure email delivery, and create the first workspace.',
    'Complete la configuración inicial: cree el administrador de la plataforma, configure el correo y cree el primer espacio de trabajo.',
    "Terminez la configuration initiale : créez l'administrateur de la plateforme, configurez la messagerie et créez le premier espace de travail.",
    '完成首次设置：创建平台管理员、配置邮件服务、创建首个工作区。',
  ],
  stepAdminTitle: [
    'Step 1: create the platform administrator',
    'Paso 1: crear el administrador de la plataforma',
    'Étape 1 : créer l’administrateur de la plateforme',
    '第 1 步：创建平台管理员',
  ],
  stepAdminBody: [
    'This is the platform’s first account. It holds platform-level permissions, and creating it closes this entry point permanently.',
    'Esta es la primera cuenta de la plataforma. Tiene permisos de nivel de plataforma y su creación cierra permanentemente este punto de entrada.',
    'Voici le premier compte de la plateforme. Il dispose des permissions de niveau plateforme et sa création ferme définitivement ce point d’entrée.',
    '这是平台的第一个账户，拥有平台级权限。创建后本入口会自动关闭，无法再次创建管理员。',
  ],
  adminEmailLabel: [
    'Administrator email',
    'Correo del administrador',
    'E-mail de l’administrateur',
    '管理员邮箱',
  ],
  adminNameLabel: ['Display name', 'Nombre visible', 'Nom affiché', '显示名称'],
  adminPasswordLabel: [
    'Administrator password',
    'Contraseña del administrador',
    'Mot de passe de l’administrateur',
    '管理员密码',
  ],
  adminPasswordHint: [
    'At least 12 characters, mixing at least three of: lowercase, uppercase, digits and symbols. Do not use spaces.',
    'Al menos 12 caracteres, combinando al menos tres de: minúsculas, mayúsculas, dígitos y símbolos. No use espacios.',
    'Au moins 12 caractères, en combinant au moins trois de : minuscules, majuscules, chiffres et symboles. N’utilisez pas d’espaces.',
    '至少 12 个字符，混合大小写字母、数字和符号中的三类，不要使用空格。',
  ],
  adminPasswordConfirmLabel: [
    'Confirm password',
    'Confirmar contraseña',
    'Confirmer le mot de passe',
    '确认密码',
  ],
  adminPasswordMismatch: [
    'The two passwords do not match.',
    'Las dos contraseñas no coinciden.',
    'Les deux mots de passe ne correspondent pas.',
    '两次输入的密码不一致。',
  ],
  createAdmin: [
    'Create administrator',
    'Crear administrador',
    'Créer l’administrateur',
    '创建管理员',
  ],
  creating: ['Working…', 'Procesando…', 'Traitement…', '正在创建…'],
  stepEmailTitle: [
    'Step 2: configure email delivery',
    'Paso 2: configurar el correo',
    'Étape 2 : configurer la messagerie',
    '第 2 步：配置邮件服务',
  ],
  stepEmailBody: [
    'Configure the platform SMTP mailbox used for sign-in links, password resets and system notifications. The password is stored encrypted and is never shown again.',
    'Configure el buzón SMTP de la plataforma para los enlaces de acceso, los restablecimientos de contraseña y las notificaciones. La contraseña se guarda cifrada y nunca se vuelve a mostrar.',
    'Configurez la boîte aux lettres SMTP de la plateforme pour les liens de connexion, les réinitialisations de mot de passe et les notifications. Le mot de passe est stocké chiffré et n’est plus jamais affiché.',
    '配置平台的 SMTP 邮箱，用于发送登录链接、密码重置和系统通知。密码会加密保存，页面不会回显。',
  ],
  stepTenantTitle: [
    'Step 3: create the first workspace',
    'Paso 3: crear el primer espacio de trabajo',
    'Étape 3 : créer le premier espace de travail',
    '第 3 步：创建首个工作区',
  ],
  stepTenantBody: [
    'A workspace holds the people, incidents, inspections and equipment data. Once it exists you can configure roles, people and project permissions inside it.',
    'Un espacio de trabajo contiene las personas, incidentes, inspecciones y equipos. Una vez creado puedes configurar roles, personas y permisos de proyecto dentro de él.',
    'Un espace de travail contient les personnes, les incidents, les inspections et les équipements. Une fois créé, vous pouvez y configurer rôles, personnes et permissions projet.',
    '工作区承载人员、事件、检查和设备等业务数据。创建后你可以在其中配置角色、人员和项目权限。',
  ],
  tenantNameLabel: [
    'Workspace name',
    'Nombre del espacio de trabajo',
    'Nom de l’espace de travail',
    '工作区名称',
  ],
  tenantSlugLabel: [
    'Identifier (optional)',
    'Identificador (opcional)',
    'Identifiant (facultatif)',
    '标识（可选）',
  ],
  tenantRegionLabel: ['Region', 'Región', 'Région', '区域'],
  createTenant: [
    'Create workspace',
    'Crear espacio de trabajo',
    'Créer l’espace de travail',
    '创建工作区',
  ],
  signInTitle: ['Sign in first', 'Inicia sesión primero', 'Connectez-vous d’abord', '请先登录'],
  signInBody: [
    'The platform administrator has been created. Sign in to finish the remaining setup steps.',
    'El administrador de la plataforma se ha creado. Inicia sesión para completar los pasos restantes.',
    'L’administrateur de la plateforme a été créé. Connectez-vous pour terminer les étapes restantes.',
    '平台管理员已经创建。登录后继续完成剩余的初始化步骤。',
  ],
  goToLogin: ['Go to sign-in', 'Ir al inicio de sesión', 'Aller à la connexion', '前往登录'],
  forbiddenTitle: ['Not allowed', 'No permitido', 'Non autorisé', '无权访问'],
  forbiddenBody: [
    'This page is open to platform administrators only.',
    'Esta página está disponible solo para los administradores de la plataforma.',
    'Cette page est réservée aux administrateurs de la plateforme.',
    '此页面只对平台管理员开放。',
  ],
  completeTitle: [
    'Setup complete',
    'Configuración completada',
    'Configuration terminée',
    '初始化已完成',
  ],
  completeBody: [
    'The platform is initialized. You can create more workspaces, configure roles and start working.',
    'La plataforma está inicializada. Puedes crear más espacios de trabajo, configurar roles y empezar a trabajar.',
    'La plateforme est initialisée. Vous pouvez créer d’autres espaces de travail, configurer les rôles et commencer à travailler.',
    '平台已经完成初始化。你可以继续创建更多工作区、配置角色并开始使用。',
  ],
  goToApp: ['Open the app', 'Abrir la aplicación', 'Ouvrir l’application', '进入系统'],
}

/** Action outcomes: [en, es, fr, zh]; the key is derived from the en value. */
const ACTION_COPY = {
  actionAlreadyInitialized: [
    'This platform is already initialized. Sign in instead.',
    'Esta plataforma ya está inicializada. Inicia sesión en su lugar.',
    'Cette plateforme est déjà initialisée. Connectez-vous plutôt.',
    '此平台已完成初始化，请直接登录。',
  ],
  actionTooManyAttempts: [
    'Too many attempts. Try again later.',
    'Demasiados intentos. Inténtalo de nuevo más tarde.',
    'Trop de tentatives. Réessayez plus tard.',
    '尝试次数过多，请稍后再试。',
  ],
  actionEmailTaken: [
    'That address is already registered. Sign in instead.',
    'Esa dirección ya está registrada. Inicia sesión en su lugar.',
    'Cette adresse est déjà enregistrée. Connectez-vous plutôt.',
    '该邮箱已被注册，请直接登录。',
  ],
  actionAdminCreated: [
    'Administrator created. Sign in to continue the setup.',
    'Administrador creado. Inicia sesión para continuar la configuración.',
    'Administrateur créé. Connectez-vous pour poursuivre la configuration.',
    '管理员已创建。登录后继续完成初始化。',
  ],
  actionNotSuperAdmin: [
    'Sign in as the platform administrator to continue.',
    'Inicia sesión como administrador de la plataforma para continuar.',
    'Connectez-vous en tant qu’administrateur de la plateforme pour continuer.',
    '请以平台管理员身份登录后继续。',
  ],
  actionTooManyTestEmails: [
    'Too many test emails. Try again later.',
    'Demasiados correos de prueba. Inténtalo de nuevo más tarde.',
    'Trop de courriels de test. Réessayez plus tard.',
    '测试邮件次数过多，请稍后再试。',
  ],
  actionWorkspaceNameMissing: [
    'Enter a workspace name.',
    'Introduce un nombre de espacio de trabajo.',
    'Saisissez un nom d’espace de travail.',
    '请输入工作区名称。',
  ],
  actionWorkspaceExists: [
    'This platform already has a workspace.',
    'Esta plataforma ya tiene un espacio de trabajo.',
    'Cette plateforme possède déjà un espace de travail.',
    '此平台已有工作区。',
  ],
  actionWorkspaceCreated: [
    'Workspace created.',
    'Espacio de trabajo creado.',
    'Espace de travail créé.',
    '工作区已创建。',
  ],
  passwordTooShort: [
    'Use at least 12 characters.',
    'Usa al menos 12 caracteres.',
    'Utilisez au moins 12 caractères.',
    '请使用至少 12 个字符。',
  ],
  passwordNoSpaces: [
    'Do not use spaces.',
    'No uses espacios.',
    'N’utilisez pas d’espaces.',
    '不要使用空格。',
  ],
  passwordTooSimple: [
    'Mix at least three of: lowercase, uppercase, digits, symbols.',
    'Combina al menos tres de: minúsculas, mayúsculas, dígitos y símbolos.',
    'Mélangez au moins trois de : minuscules, majuscules, chiffres et symboles.',
    '请混合使用小写字母、大写字母、数字、符号中的至少三类。',
  ],
  passwordRepeated: [
    'Do not repeat a single character.',
    'No repitas un solo carácter.',
    'Ne répétez pas un seul caractère.',
    '不要重复同一个字符。',
  ],
}

const base = new URL('../packages/i18n/src/messages/', import.meta.url)
const checkOnly = process.argv.includes('--check')

let written = 0
let unchanged = 0
const conflicts = []

for (const [group, entries, sourceIndex] of [
  ['page', PAGE_COPY, 3],
  ['action', ACTION_COPY, 0],
]) {
  for (const [name, values] of Object.entries(entries)) {
    const key = systemMessageKey(values[sourceIndex])
    LOCALES.forEach((locale, index) => {
      const file = new URL(`${locale}.json`, base)
      const catalogue = JSON.parse(readFileSync(file, 'utf8'))
      catalogue.Generated ??= {}
      const existing = catalogue.Generated[key]
      if (existing !== undefined) {
        if (existing !== values[index]) {
          conflicts.push(`${group}.${name} [${locale}] ${key}: catalogue holds a different value`)
        } else {
          unchanged += 1
        }
        return
      }
      if (!checkOnly) {
        catalogue.Generated[key] = values[index]
        writeFileSync(file, `${JSON.stringify(catalogue, null, 2)}\n`)
      }
      written += 1
    })
  }
}

console.log(
  `entries: ${written} ${checkOnly ? 'would be written' : 'written'}, ${unchanged} already present`,
)
if (conflicts.length > 0) {
  console.log('')
  console.log('CONFLICTS (left untouched):')
  for (const conflict of conflicts) console.log(`  ${conflict}`)
  process.exitCode = 1
}
