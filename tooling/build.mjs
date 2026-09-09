#!/usr/bin/env node
import { resolve } from 'node:path'
import { compileRouteManifest } from '../src/tooling/manifest.ts'

const arguments_ = process.argv.slice(2)
const source = arguments_.includes('--source') || process.env.SPRINDLE_SOURCE_MANIFEST === '1'
const positional = arguments_.filter((value) => value !== '--source')
const target = await compileRouteManifest(resolve(positional[0] ?? process.cwd()), positional[1] ?? 'routes', '.sprindle/routes.mjs', !source)
process.stdout.write(`${target}\n`)
