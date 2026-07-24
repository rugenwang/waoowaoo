import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

const helperPath = resolve(process.cwd(), 'tests/setup/test-compose.ts')
const helperExists = existsSync(helperPath)
const execFileSyncMock = vi.mocked(execFileSync)

type TestComposeModule = typeof import('../../setup/test-compose')

it('provides a dedicated test compose helper', () => {
  expect(helperExists).toBe(true)
})

describe.skipIf(!helperExists)('test compose project isolation', () => {
  let testCompose: TestComposeModule

  beforeAll(async () => {
    testCompose = await import('../../setup/test-compose')
  })

  beforeEach(() => {
    execFileSyncMock.mockClear()
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

  it('executes the isolated up command without a shell', () => {
    testCompose.runTestComposeUp()

    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'docker',
      [
        'compose',
        '--project-name',
        'waoowaoo-test-runtime',
        '-f',
        'docker-compose.test.yml',
        'up',
        '-d',
        '--remove-orphans',
      ],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
      },
    )
  })

  it('executes the isolated down command without a shell', () => {
    testCompose.runTestComposeDown()

    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'docker',
      [
        'compose',
        '--project-name',
        'waoowaoo-test-runtime',
        '-f',
        'docker-compose.test.yml',
        'down',
        '-v',
        '--remove-orphans',
      ],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
      },
    )
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
    expect(globalSetupSource).not.toMatch(/['"`]docker['"`]/)
    expect(globalSetupSource).not.toMatch(/\bexecFileSync\(\s*['"`]docker['"`]/)
  })

  it('routes teardown compose operations through the isolated helper', () => {
    expect(globalTeardownSource).toContain("from './test-compose'")
    expect(globalTeardownSource).toContain('runTestComposeDown()')
    expect(globalTeardownSource).not.toContain('docker compose')
    expect(globalTeardownSource).not.toMatch(/\bexecSync\(\s*['"`]docker compose/)
    expect(globalTeardownSource).not.toMatch(/['"`]docker['"`]/)
    expect(globalTeardownSource).not.toMatch(/\bexecFileSync\(\s*['"`]docker['"`]/)
  })
})

describe('documented test compose commands', () => {
  const planSource = readFileSync(
    resolve(
      process.cwd(),
      'docs/qsuperpowers/waoo-video-creator/plans/agent-data-api-implementation-plan.md',
    ),
    'utf8',
  )

  it('always uses the isolated test project name', () => {
    const testComposeCommands = planSource
      .split('\n')
      .filter((line) => line.includes('docker compose') && line.includes('docker-compose.test.yml'))

    expect(testComposeCommands.length).toBeGreaterThan(0)
    for (const command of testComposeCommands) {
      expect(command).toContain(
        'docker compose --project-name waoowaoo-test-runtime -f docker-compose.test.yml',
      )
    }
  })
})
