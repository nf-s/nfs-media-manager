/*
 * Style check: page stylesheets and components outside the design system use
 * the `--ds-*` tokens, and style files live only in the design system and the
 * page-layout folder.
 *
 * It reports, outside `packages/ui/src/design-system`, `components/ds`,
 * `components/ui` and `docs/design-system`:
 *   colour  a literal colour (hex, rgb(), hsl(), a colour name, a Tailwind
 *           colour class)
 *   font    a literal font family
 *   shadow  a literal shadow
 *   radius  a literal corner radius
 *   size    a literal size equal to a token of its kind: a type size for
 *           font sizes, a space step for margins, padding, gaps and offsets,
 *           a control, row or layout size for widths and heights, a leading
 *           for line heights
 *   file    a style file outside the design system and `packages/ui/src/styles`
 *
 * Findings that existed when the check began are listed in
 * `style-baseline.json` and allowed; the check fails on any others.
 *
 *   node packages/ui/scripts/check-styles.mjs           check
 *   node packages/ui/scripts/check-styles.mjs --report  counts by file
 *   node packages/ui/scripts/check-styles.mjs --update  rewrite the baseline
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  compactExcerpt,
  compareWithBaseline,
  lineAt,
  listFiles,
  loadBaseline,
  printStale,
  printTotals,
  readRepoFile,
  repoRoot,
  writeBaseline,
} from './design-check-baseline.mjs'

const baselinePath = join(repoRoot, 'packages/ui/scripts/style-baseline.json')
const tokensPath = 'packages/ui/src/design-system/tokens.css'
const updateCommand = 'pnpm --filter @repo/ui check:styles --update'

const styleFilePattern = /\.(css|scss|sass|less|styl|pcss)$/
const styleHomes = [
  'packages/ui/src/design-system/',
  'packages/ui/src/styles/',
  'docs/design-system/',
]
const styleEntry = 'packages/ui/src/globals.css'
const designSystemSources = [
  'packages/ui/src/design-system/',
  'packages/ui/src/components/ds/',
  'packages/ui/src/components/ui/',
  'packages/ui/src/lib/',
  'docs/design-system/',
]

const cssWideKeywords = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
])

// prettier-ignore
const namedColours = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige',
  'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown',
  'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral',
  'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki',
  'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred',
  'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray',
  'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue',
  'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite',
  'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod',
  'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred',
  'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen',
  'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink',
  'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray',
  'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen',
  'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue',
  'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace',
  'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod',
  'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff',
  'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red',
  'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray',
  'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle',
  'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
])

/** Properties whose identifiers are names, not colours. */
const nameProperties =
  /^(font|font-family|grid-template-areas|grid-area|grid-(row|column)(-start|-end)?|animation(-name)?|transition(-property)?|will-change|content|counter-(reset|increment|set)|list-style(-type)?|quotes|container(-name)?|view-transition-name|anchor-name|position-anchor|text-overflow)$/

const spaceProperties =
  /^((margin|padding|scroll-margin|scroll-padding|inset)(-[a-z-]+)?|gap|row-gap|column-gap|top|right|bottom|left|text-indent|border-spacing|translate)$/
const dimensionProperties =
  /^((min-|max-)?(width|height|inline-size|block-size)|flex-basis|flex|grid-template(-columns|-rows)?|grid-auto-(columns|rows))$/
const textProperties = /^(font-size|font)$/

const colourFunction = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
const hexColour = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/i
const length = /(-?\d*\.?\d+)(px|rem)(?![a-z])/gi

/** Token values by kind, read from tokens.css so the check follows it. */
export function readTokens(css) {
  const tokens = {
    text: new Map(),
    space: new Map(),
    dimension: new Map(),
    leading: new Map(),
  }
  for (const match of css.matchAll(/(--ds-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, raw] = match
    const value = raw.trim()
    const px = /^(\d*\.?\d+)px$/.exec(value)
    if (name.startsWith('--ds-leading')) {
      if (/^\d*\.?\d+$/.test(value)) tokens.leading.set(Number(value), name)
      continue
    }
    if (!px || name.startsWith('--ds-r-')) continue
    const size = Number(px[1])
    if (name.startsWith('--ds-text-')) tokens.text.set(size, name)
    else if (/^--ds-\d+$/.test(name)) tokens.space.set(size, name)
    else {
      tokens.dimension.set(size, name)
      if (name === '--ds-gutter') tokens.space.set(size, name)
    }
  }
  return tokens
}

/** Replaces `var(--x, fallback)` with its fallback, so a literal fallback is still seen. */
export function withoutVars(value) {
  let out = ''
  let at = 0
  while (at < value.length) {
    const start = value.indexOf('var(', at)
    if (start < 0) {
      out += value.slice(at)
      break
    }
    out += value.slice(at, start)
    let depth = 0
    let end = start + 3
    for (; end < value.length; end += 1) {
      if (value[end] === '(') depth += 1
      else if (value[end] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const inner = value.slice(start + 4, end)
    const comma = topLevelComma(inner)
    out += ` ${comma < 0 ? '' : withoutVars(inner.slice(comma + 1))} `
    at = end + 1
  }
  return out
}

function topLevelComma(text) {
  let depth = 0
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '(') depth += 1
    else if (text[at] === ')') depth -= 1
    else if (text[at] === ',' && depth === 0) return at
  }
  return -1
}

function withoutStrings(value) {
  return value
    .replace(/url\((?:[^)"']|"[^"]*"|'[^']*')*\)/gi, ' ')
    .replace(/"[^"]*"|'[^']*'/g, ' ')
}

function sizeKind(property) {
  if (property.startsWith('--')) return 'any'
  if (textProperties.test(property)) return 'text'
  if (spaceProperties.test(property)) return 'space'
  if (dimensionProperties.test(property)) return 'dimension'
  return undefined
}

function tokenFor(tokens, kind, size) {
  if (kind === 'any') {
    return (
      tokens.text.get(size) ??
      tokens.space.get(size) ??
      tokens.dimension.get(size)
    )
  }
  return tokens[kind].get(size)
}

function onlyKeywords(value, extra = []) {
  const allowed = new Set([...cssWideKeywords, ...extra])
  return value
    .split(/[\s,/]+/)
    .filter(Boolean)
    .every((word) => allowed.has(word.toLowerCase()))
}

/** The rules one declaration breaks, as `{ rule, detail }`. */
export function checkDeclaration(rawProperty, rawValue, tokens) {
  const property = rawProperty.trim().toLowerCase()
  const value = rawValue.replace(/!important\s*$/i, '').trim()
  const findings = []
  const plain = withoutVars(value)
  const bare = withoutStrings(plain)

  if (
    hexColour.test(bare) ||
    colourFunction.test(bare) ||
    (!nameProperties.test(property) &&
      bare
        .toLowerCase()
        .split(/[^a-z-]+/)
        .some((word) => namedColours.has(word)))
  ) {
    findings.push({ rule: 'colour' })
  }

  if (property === 'font-family' && !onlyKeywords(plain)) {
    findings.push({ rule: 'font' })
  } else if (property === 'font') {
    const words = plain
      .replace(length, ' ')
      .split(/[\s/]+/)
      .filter(Boolean)
    const fontKeywords = new Set([
      ...cssWideKeywords,
      'normal',
      'italic',
      'oblique',
      'bold',
      'bolder',
      'lighter',
      'small-caps',
    ])
    if (words.some((word) => !fontKeywords.has(word) && !/^\d+$/.test(word))) {
      findings.push({ rule: 'font' })
    }
  }

  if (/^(box|text)-shadow$/.test(property)) {
    if (!onlyKeywords(plain, ['none'])) findings.push({ rule: 'shadow' })
  } else if (/filter$/.test(property) && /drop-shadow\(/i.test(value)) {
    const shadows = [
      ...value.matchAll(/drop-shadow\(([^()]*(\([^()]*\))*)\)/gi),
    ]
    if (shadows.some(([, inner]) => withoutVars(inner).trim())) {
      findings.push({ rule: 'shadow' })
    }
  }

  if (/radius$/.test(property)) {
    const fromToken = /calc\(/i.test(value) && /var\(--ds-/.test(value)
    const literal = plain
      .split(/[\s/]+/)
      .filter(Boolean)
      .some(
        (word) => /\d/.test(word) && !/^-?0*\.?0+(px|rem|em|%)?$/.test(word),
      )
    if (literal && !fromToken) findings.push({ rule: 'radius' })
  }

  const kind = sizeKind(property)
  if (kind) {
    const seen = new Set()
    for (const [, number, unit] of withoutStrings(plain).matchAll(length)) {
      const size =
        Math.abs(Number(number)) * (unit.toLowerCase() === 'rem' ? 16 : 1)
      const token = size === 0 ? undefined : tokenFor(tokens, kind, size)
      if (token && !seen.has(token)) {
        seen.add(token)
        findings.push({ rule: 'size', detail: token })
      }
    }
  }
  if (property === 'line-height' && /^\d*\.?\d+$/.test(plain.trim())) {
    const token = tokens.leading.get(Number(plain.trim()))
    if (token) findings.push({ rule: 'size', detail: token })
  }
  return findings
}

/** Comments become spaces, so offsets and lines stay put. */
function blankCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, ' '),
  )
}

/** Each declaration in a stylesheet, as `{ property, value, index }`. */
export function* cssDeclarations(source) {
  const css = blankCssComments(source)
  let start = 0
  let depth = 0
  let quote = ''
  for (let at = 0; at < css.length; at += 1) {
    const char = css[at]
    if (quote) {
      if (char === '\\') at += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && char === '{') start = at + 1
    else if (depth === 0 && (char === ';' || char === '}')) {
      const segment = css.slice(start, at)
      const colon = segment.indexOf(':')
      const lead = segment.length - segment.trimStart().length
      if (colon > 0 && !segment.trimStart().startsWith('@')) {
        const property = segment.slice(0, colon).trim()
        if (/^(--)?[a-zA-Z-]+$/.test(property)) {
          yield {
            property,
            value: segment.slice(colon + 1).trim(),
            index: start + lead,
          }
        }
      }
      start = at + 1
    }
  }
}

export function scanStylesheet(file, source, tokens) {
  const findings = []
  for (const { property, value, index } of cssDeclarations(source)) {
    for (const { rule, detail } of checkDeclaration(property, value, tokens)) {
      findings.push({
        file,
        line: lineAt(source, index),
        rule,
        detail,
        excerpt: compactExcerpt(`${property}: ${value}`),
      })
    }
  }
  return findings
}

/**
 * The source with comments blanked and string contents masked, plus each
 * string literal's contents and offset. Good enough for components: template
 * literals are taken whole and regular expressions are not recognised.
 */
export function maskSource(source) {
  const strings = []
  let masked = ''
  let at = 0
  while (at < source.length) {
    const char = source[at]
    const next = source[at + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', at)
      const stop = end < 0 ? source.length : end
      masked += ' '.repeat(stop - at)
      at = stop
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2)
      const stop = end < 0 ? source.length : end + 2
      masked += source.slice(at, stop).replace(/[^\n]/g, ' ')
      at = stop
    } else if (char === '"' || char === "'" || char === '`') {
      let end = at + 1
      while (end < source.length && source[end] !== char) {
        if (source[end] === '\\') end += 1
        else if (char !== '`' && source[end] === '\n') break
        end += 1
      }
      strings.push({ index: at, value: source.slice(at + 1, end) })
      masked += char + source.slice(at + 1, end).replace(/[^\n]/g, ' ') + char
      at = end + 1
    } else {
      masked += char
      at += 1
    }
  }
  return { masked, strings }
}

function closingBrace(masked, open) {
  let depth = 0
  for (let at = open; at < masked.length; at += 1) {
    if (masked[at] === '{' || masked[at] === '(') depth += 1
    else if (masked[at] === '}' || masked[at] === ')') {
      depth -= 1
      if (depth === 0) return at
    }
  }
  return masked.length
}

const tailwindColours =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black|primary|secondary|muted|accent|background|foreground|border|input|ring|destructive|card|popover'
const tailwindColourClass = new RegExp(
  `^(bg|text|border(-[xytrbl])?|ring|ring-offset|outline|fill|stroke|divide|from|via|to|decoration|accent|caret|placeholder)-(${tailwindColours})(-foreground)?(-\\d+)?(\\/\\d+)?$`,
)
const tailwindSpace = {
  m: 'margin',
  mx: 'margin',
  my: 'margin',
  mt: 'margin',
  mr: 'margin',
  mb: 'margin',
  ml: 'margin',
  ms: 'margin',
  me: 'margin',
  p: 'padding',
  px: 'padding',
  py: 'padding',
  pt: 'padding',
  pr: 'padding',
  pb: 'padding',
  pl: 'padding',
  ps: 'padding',
  pe: 'padding',
  gap: 'gap',
  'gap-x': 'gap',
  'gap-y': 'gap',
  'space-x': 'gap',
  'space-y': 'gap',
  inset: 'inset',
  'inset-x': 'inset',
  'inset-y': 'inset',
  top: 'top',
  right: 'right',
  bottom: 'bottom',
  left: 'left',
  start: 'inset',
  end: 'inset',
}
const tailwindDimension = {
  w: 'width',
  h: 'height',
  size: 'width',
  'min-w': 'min-width',
  'min-h': 'min-height',
  'max-w': 'max-width',
  'max-h': 'max-height',
  basis: 'flex-basis',
}
const tailwindArbitrary = {
  ...tailwindSpace,
  ...tailwindDimension,
  bg: 'background',
  border: 'border-color',
  ring: 'box-shadow',
  rounded: 'border-radius',
  shadow: 'box-shadow',
  font: 'font-family',
  leading: 'line-height',
  fill: 'fill',
  stroke: 'stroke',
}
const tailwindTextSizes = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
}

function splitVariants(token) {
  let depth = 0
  let last = 0
  for (let at = 0; at < token.length; at += 1) {
    if (token[at] === '[') depth += 1
    else if (token[at] === ']') depth -= 1
    else if (token[at] === ':' && depth === 0) last = at + 1
  }
  return token.slice(last).replace(/^!/, '')
}

/** The rules one Tailwind class breaks. */
export function checkClass(rawToken, tokens) {
  const token = splitVariants(rawToken)
  const negative = token.startsWith('-')
  const name = negative ? token.slice(1) : token
  const arbitrary = /^([a-z-]+?)-\[(.+)\]$/.exec(name)
  if (arbitrary) {
    const [, prefix, raw] = arbitrary
    const value = `${negative ? '-' : ''}${raw.replace(/_/g, ' ')}`
    const colourLike = hexColour.test(value) || colourFunction.test(value)
    const property =
      prefix === 'text'
        ? colourLike
          ? 'color'
          : 'font-size'
        : (tailwindArbitrary[prefix] ?? (colourLike ? 'color' : undefined))
    return property ? checkDeclaration(property, value, tokens) : []
  }
  if (tailwindColourClass.test(name)) return [{ rule: 'colour' }]
  if (/^rounded(-[a-z]+)*$/.test(name) && name !== 'rounded-none') {
    return [{ rule: 'radius' }]
  }
  if (/^shadow(-[a-z0-9]+)?$/.test(name) && name !== 'shadow-none') {
    return [{ rule: 'shadow' }]
  }
  if (/^font-(sans|serif|mono)$/.test(name)) return [{ rule: 'font' }]
  const text = /^text-([a-z0-9]+)$/.exec(name)
  if (text && tailwindTextSizes[text[1]]) {
    const token = tokens.text.get(tailwindTextSizes[text[1]])
    return token ? [{ rule: 'size', detail: token }] : []
  }
  const scale = /^([a-z-]+?)-(\d+(?:\.\d+)?|px)$/.exec(name)
  if (scale) {
    const [, prefix, step] = scale
    const property = tailwindSpace[prefix] ?? tailwindDimension[prefix]
    if (!property) return []
    const size = step === 'px' ? 1 : Number(step) * 4
    return checkDeclaration(property, `${size}px`, tokens)
  }
  return []
}

const unitlessStyleProperties =
  /^(flex|flex-grow|flex-shrink|opacity|z-index|order|font-weight|line-height|zoom|scale|grid-row|grid-column|aspect-ratio|tab-size|orphans|widows)$/
const svgColourAttribute =
  /\b(fill|stroke|color|stopColor|floodColor|lightingColor)=(["'])([^"']*)\2/g

function kebab(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/** Findings in one TypeScript or TSX source outside the design system. */
export function scanComponent(file, source, tokens) {
  const { masked, strings } = maskSource(source)
  const findings = []
  const add = (index, rule, detail, excerpt) => {
    findings.push({
      file,
      line: lineAt(source, index),
      rule,
      detail,
      excerpt: compactExcerpt(excerpt),
    })
  }
  const counted = new Set()

  // Inline style objects
  for (const match of masked.matchAll(/style=\{\{/g)) {
    const open = match.index + 'style={'.length
    const close = closingBrace(masked, open)
    const body = masked.slice(open + 1, close + 1)
    const entry =
      /([A-Za-z]+|(["'])[^"']*\2)\s*:\s*((["'`])[^"'`]*\4|-?\d*\.?\d+)\s*(?=[,}\n])/g
    for (const property of body.matchAll(entry)) {
      const at = open + 1 + property.index
      const keyText = source.slice(at, at + property[1].length)
      const valueStart = at + property[0].indexOf(property[3])
      const literal = source.slice(valueStart, valueStart + property[3].length)
      const name = kebab(keyText.replace(/^["']|["']$/g, ''))
      const isString = /^["'`]/.test(literal)
      const value = isString
        ? literal.slice(1, -1)
        : unitlessStyleProperties.test(name)
          ? literal
          : `${literal}px`
      for (const { rule, detail } of checkDeclaration(name, value, tokens)) {
        if (isString) counted.add(valueStart)
        add(at, rule, detail, `style ${name}: ${value}`)
      }
    }
  }

  // Class names given to className, cn(), clsx(), cva() and twMerge()
  const classRanges = []
  for (const match of masked.matchAll(
    /\bclassName=(\{|["'])|\b(cn|clsx|cva|twMerge)\(/g,
  )) {
    const open = match.index + match[0].length - 1
    const close = /["']/.test(masked[open])
      ? masked.indexOf(masked[open], open + 1)
      : closingBrace(masked, open)
    classRanges.push([open, close])
  }
  for (const string of strings) {
    if (
      !classRanges.some(
        ([open, close]) => string.index >= open && string.index <= close,
      )
    ) {
      continue
    }
    for (const token of string.value.split(/\s+/).filter(Boolean)) {
      if (token.includes('${')) continue
      for (const { rule, detail } of checkClass(token, tokens)) {
        counted.add(string.index)
        add(string.index, rule, detail, `class ${token}`)
      }
    }
  }

  // SVG and element colour attributes
  for (const match of source.matchAll(svgColourAttribute)) {
    const [, attribute, , value] = match
    if (/^(none|currentcolor|transparent|inherit)$/i.test(value)) continue
    if (/^var\(--ds-[a-z0-9-]+\)$/.test(value)) continue
    counted.add(match.index + attribute.length + 1)
    add(match.index, 'colour', undefined, `${attribute}="${value}"`)
  }

  // Any other string that is, or carries, a literal colour
  for (const string of strings) {
    if (counted.has(string.index)) continue
    const value = string.value.trim()
    const whole = new RegExp(`^${hexColour.source}$`, 'i').test(value)
    const inline =
      /[:(,]\s*#[0-9a-f]{3,8}\b/i.test(value) ||
      /\b(rgba?|hsla?|oklch|oklab)\(\s*[\d.]/i.test(value)
    if (whole || inline) add(string.index, 'colour', undefined, `"${value}"`)
  }
  return findings
}

function isStyleFile(path) {
  return styleFilePattern.test(path)
}

function isComponentSource(path) {
  if (!/\.(ts|tsx|jsx)$/.test(path) || /\.d\.ts$/.test(path)) return false
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return false
  if (designSystemSources.some((home) => path.startsWith(home))) return false
  if (path.startsWith('apps/web/scripts/')) return false
  return path.startsWith('apps/web/') || path.startsWith('packages/ui/src/')
}

export function collectFindings(files, read, tokens) {
  const findings = []
  const strayStyleFiles = []
  for (const file of files) {
    if (isStyleFile(file)) {
      const inHome =
        file === styleEntry || styleHomes.some((home) => file.startsWith(home))
      if (!inHome) strayStyleFiles.push(file)
      if (designSystemSources.some((home) => file.startsWith(home))) continue
      findings.push(...scanStylesheet(file, read(file), tokens))
    } else if (isComponentSource(file)) {
      findings.push(...scanComponent(file, read(file), tokens))
    }
  }
  return { findings, strayStyleFiles }
}

function describe(finding) {
  const detail = finding.detail ? ` (use ${finding.detail})` : ''
  return `${finding.file}:${finding.line}  ${finding.rule}${detail}  ${finding.excerpt}`
}

function main(argv) {
  const tokens = readTokens(readRepoFile(tokensPath))
  const { findings, strayStyleFiles } = collectFindings(
    listFiles(),
    readRepoFile,
    tokens,
  )
  const baseline = loadBaseline(baselinePath)

  if (argv.includes('--update')) {
    writeBaseline(baselinePath, {
      description:
        'Style findings that existed before the style check. Allowed, not endorsed: remove entries as the interface is fixed. Rewrite with `pnpm --filter @repo/ui check:styles --update`.',
      files: strayStyleFiles,
      findings,
    })
    printTotals(findings, 'Baselined style findings')
    console.log(
      `Baselined style files outside the design system: ${strayStyleFiles.length}`,
    )
    return 0
  }
  if (argv.includes('--report')) {
    printTotals(findings, 'Style findings')
    console.log(
      `\nStyle files outside the design system: ${strayStyleFiles.length}`,
    )
    for (const file of strayStyleFiles) console.log(`  ${file}`)
    return 0
  }

  const { fresh, stale } = compareWithBaseline(findings, baseline)
  const newFiles = strayStyleFiles.filter(
    (file) => !baseline.files.includes(file),
  )
  if (fresh.length || newFiles.length) {
    console.error(
      'Style check failed. Use the --ds-* tokens and the shared components; see docs/design-system/README.md.\n',
    )
    for (const file of newFiles) {
      console.error(
        `${file}  file  style files belong in packages/ui/src/design-system or packages/ui/src/styles`,
      )
    }
    for (const finding of fresh) console.error(describe(finding))
    console.error(
      `\n${fresh.length + newFiles.length} findings not in packages/ui/scripts/style-baseline.json.`,
    )
    return 1
  }
  console.log(
    `Style check passed: ${findings.length} baselined findings, ${strayStyleFiles.length} baselined style files, none new.`,
  )
  printStale(stale, updateCommand)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
