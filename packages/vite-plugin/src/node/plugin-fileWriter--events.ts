import fsExtra from 'fs-extra' 
const { pathExistsSync, outputFile, statSync } = fsExtra
import { performance } from 'perf_hooks'
import colors from 'picocolors'
import { ChangeEvent, OutputBundle, OutputOptions, RollupOptions } from 'rollup'
import {
  BehaviorSubject,
  filter,
  first,
  firstValueFrom,
  interval,
  map,
  mapTo,
  Subject,
  switchMap,
} from 'rxjs'
import { createLogger, ViteDevServer } from 'vite'
import { isString, _debug } from './helpers'
import { join, relative } from './path'
import { CrxPluginFn } from './types'

export const debug = _debug('file-writer').extend('events')

type FileWriterEvent =
  | { type: 'init' }
  | {
      type: 'buildStart'
      options: RollupOptions
    }
  | {
      type: 'writeBundle'
      options: OutputOptions
      bundle: OutputBundle
      duration: number
      timestamp: number
    }
  | {
      type: 'error'
      error?: Error
      code?: string
      frame?: string
    }
  | { type: 'change'; id: string; event: ChangeEvent }

export const writerEvent$ = new BehaviorSubject<FileWriterEvent>({
  type: 'init',
})

writerEvent$.subscribe((event) => {
  debug('watcher event %O', event.type)
  if (event.type === 'error') {
    debug('watcher error %O', event.error)
  }
})

export const filesError$ = writerEvent$.pipe(
  filter((x): x is Extract<FileWriterEvent, { type: 'error' }> => {
    return x.type === 'error'
  }),
)

export const filesStart$ = writerEvent$.pipe(
  filter((x): x is Extract<FileWriterEvent, { type: 'buildStart' }> => {
    return x.type === 'buildStart'
  }),
)

export const filesStart = () => firstValueFrom(filesStart$)

export const filesReady$ = writerEvent$.pipe(
  filter((x): x is Extract<FileWriterEvent, { type: 'writeBundle' }> => {
    return x.type === 'writeBundle'
  }),
  switchMap((event) =>
    // poll fs until files are updated
    interval(100).pipe(
      mapTo(event),
      first(({ bundle, options, timestamp }) => {
        const result = Object.keys(bundle).every((p) => {
          const stats = statSync(join(options.dir!, p))
          // compare stats on disk with timestamp
          return stats.mtimeMs > timestamp
        })
        return result
      }),
    ),
  ),
)

export const filesReady = () => firstValueFrom(filesReady$)

export const server$ = new Subject<ViteDevServer>()
export const triggerName = firstValueFrom(
  server$.pipe(
    map(({ config: { cacheDir } }) => cacheDir),
    filter(isString),
    map((dir) => join(dir, '.crx-watch-trigger')),
  ),
)

/** Trigger a rebuild from other plugins */
export const rebuildFiles = async (): Promise<void> => {
  debug('rebuildFiles start')
  await filesReady()
  await Promise.all([
    outputFile(await triggerName, Date.now().toString()),
    filesStart(),
  ])
  await filesReady()
  debug('rebuildFiles end')
}

function startLogger(server: ViteDevServer) {
  const logger = createLogger(server.config.logLevel, {
    prefix: '[crx]',
  })

  const subs = [
    filesStart$.subscribe(() => {
      const message = colors.green('files start')
      const outDir = colors.dim(
        relative(server.config.root, server.config.build.outDir),
      )
      logger.info(`${message} ${outDir}`, { timestamp: true })
    }),

    filesReady$.subscribe(({ duration: d }) => {
      const message = colors.green('files ready')
      const duration = colors.dim(`in ${colors.bold(`${d}ms`)}`)
      logger.info(`${message} ${duration}`, { timestamp: true })
    }),

    // TODO: log runtime reload from crxHmrPayload$

    filesError$.subscribe(({ error }) => {
      logger.error(colors.dim('error from file writer:'), { timestamp: true })
      if (error) {
        const message = error?.stack ?? error.message
        logger.error(colors.red(message))
      }
    }),
  ]

  return () => subs.forEach((sub) => sub.unsubscribe())
}

/**
 * This plugin emits build events so other plugins can track the file writer state.
 *
 * It only runs during development inside the file writer Rollup watch instance.
 */
export const pluginFileWriterEvents: CrxPluginFn = () => {
  let start = performance.now()
  let stopLogger: () => void
  return {
    name: 'crx:file-writer-events',
    enforce: 'post',
    apply: 'build',
    fileWriterStart(server) {
      debug('fileWriterStart')
      stopLogger = startLogger(server)
    },
    closeWatcher() {
      debug('closeWatcher')
      stopLogger()
    },
    async buildStart(options) {
      start = performance.now()
      const filename = await triggerName
      if (!pathExistsSync(filename)) {
        await outputFile(filename, Date.now().toString())
      }
      this.addWatchFile(filename)
      writerEvent$.next({ type: 'buildStart', options })
      debug('buildStart')
    },
    writeBundle(options, bundle) {
      const timestamp = performance.now()
      const duration = Math.round(timestamp - start)
      writerEvent$.next({
        type: 'writeBundle',
        options,
        bundle,
        duration,
        timestamp,
      })
      debug('writeBundle')
    },
    renderError(error) {
      writerEvent$.next({ type: 'error', error })
    },
    watchChange(id, { event }) {
      writerEvent$.next({ type: 'change', id, event })
    },
  }
}
