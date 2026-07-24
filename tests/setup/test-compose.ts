import { execFileSync } from 'node:child_process'

export const TEST_COMPOSE_PROJECT_NAME = 'waoowaoo-test-runtime'

const TEST_COMPOSE_FILE = 'docker-compose.test.yml'

function buildTestComposeBaseArgs(): string[] {
  return [
    'compose',
    '--project-name',
    TEST_COMPOSE_PROJECT_NAME,
    '-f',
    TEST_COMPOSE_FILE,
  ]
}

export function buildTestComposeUpArgs(): string[] {
  return [...buildTestComposeBaseArgs(), 'up', '-d', '--remove-orphans']
}

export function buildTestComposeDownArgs(): string[] {
  return [...buildTestComposeBaseArgs(), 'down', '-v', '--remove-orphans']
}

function runTestCompose(args: string[]) {
  execFileSync('docker', args, {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
}

export function runTestComposeUp() {
  runTestCompose(buildTestComposeUpArgs())
}

export function runTestComposeDown() {
  runTestCompose(buildTestComposeDownArgs())
}
