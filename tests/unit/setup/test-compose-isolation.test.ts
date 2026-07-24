import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const helperPath = resolve(process.cwd(), 'tests/setup/test-compose.ts')
const helperExists = existsSync(helperPath)

type TestComposeModule = typeof import('../../setup/test-compose')

it('provides a dedicated test compose helper', () => {
  expect(helperExists).toBe(true)
})

describe.skipIf(!helperExists)('test compose project isolation', () => {
  let testCompose: TestComposeModule

  beforeAll(async () => {
    testCompose = await import('../../setup/test-compose')
  })

  it('uses a fixed project name distinct from the main stack', () => {
    expect(testCompose.TEST_COMPOSE_PROJECT_NAME).toBe('waoowaoo-test-runtime')
    expect(testCompose.TEST_COMPOSE_PROJECT_NAME).not.toBe('waoowaoo')
  })

  it('builds the isolated up command arguments', () => {
    expect(testCompose.buildTestComposeUpArgs()).toEqual([
      'compose',
      '--project-name',
      'waoowaoo-test-runtime',
      '-f',
      'docker-compose.test.yml',
      'up',
      '-d',
      '--remove-orphans',
    ])
  })

  it('builds the isolated down command arguments', () => {
    expect(testCompose.buildTestComposeDownArgs()).toEqual([
      'compose',
      '--project-name',
      'waoowaoo-test-runtime',
      '-f',
      'docker-compose.test.yml',
      'down',
      '-v',
      '--remove-orphans',
    ])
  })

  it('does not derive command arguments from the working directory', () => {
    const originalCwd = process.cwd()
    const upArgs = testCompose.buildTestComposeUpArgs()
    const downArgs = testCompose.buildTestComposeDownArgs()

    try {
      process.chdir(tmpdir())
      expect(testCompose.buildTestComposeUpArgs()).toEqual(upArgs)
      expect(testCompose.buildTestComposeDownArgs()).toEqual(downArgs)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('cannot build an up or down command without an explicit project name', () => {
    for (const buildArgs of [
      testCompose.buildTestComposeUpArgs,
      testCompose.buildTestComposeDownArgs,
    ]) {
      const args = buildArgs()
      const projectNameFlag = args.indexOf('--project-name')

      expect(projectNameFlag).toBeGreaterThan(-1)
      expect(args[projectNameFlag + 1]).toBe(testCompose.TEST_COMPOSE_PROJECT_NAME)
      expect(args.slice(0, 5)).toEqual([
        'compose',
        '--project-name',
        testCompose.TEST_COMPOSE_PROJECT_NAME,
        '-f',
        'docker-compose.test.yml',
      ])
    }
  })
})

describe('global test lifecycle compose boundary', () => {
  const globalSetupSource = readFileSync(
    resolve(process.cwd(), 'tests/setup/global-setup.ts'),
    'utf8',
  )
  const globalTeardownSource = readFileSync(
    resolve(process.cwd(), 'tests/setup/global-teardown.ts'),
    'utf8',
  )

  it('routes setup compose operations through the isolated helper', () => {
    expect(globalSetupSource).toContain("from './test-compose'")
    expect(globalSetupSource).toContain('runTestComposeDown()')
    expect(globalSetupSource).toContain('runTestComposeUp()')
    expect(globalSetupSource).not.toContain('docker compose')
    expect(globalSetupSource).not.toMatch(/\bexecSync\(\s*['"`]docker compose/)
  })

  it('routes teardown compose operations through the isolated helper', () => {
    expect(globalTeardownSource).toContain("from './test-compose'")
    expect(globalTeardownSource).toContain('runTestComposeDown()')
    expect(globalTeardownSource).not.toContain('docker compose')
    expect(globalTeardownSource).not.toMatch(/\bexecSync\(\s*['"`]docker compose/)
  })
})
