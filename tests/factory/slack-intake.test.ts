import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workBoard } from '@mastra/factory';
import { SlackIntegration } from '@mastra/factory/integrations/slack/integration';
import { BeadsIntegration } from '@samskara/factory-beads';
import { describe, expect, it } from 'vitest';

// samskara-ylt. Before 0.31 a Slack thread upserted its own card straight into
// Building, so Slack work skipped Triage and planning. In 0.31 a Slack thread is
// a session, and a card only exists when that session's agent files one with
// factory_create_work_item, which goes through the project's intake routes onto
// Work's Intake, from where the only working move is Planning. These checks pin
// that, so a Factory upgrade that brings back Slack-made cards, or opens a move
// from Intake straight into Building, fails here instead of in production.
// See docs/setup/slack-app.md#where-slack-work-lands.

const factoryDist = dirname(fileURLToPath(import.meta.resolve('@mastra/factory')));
const read = (path: string) => readFileSync(join(factoryDist, path), 'utf8');

describe('Slack work in @mastra/factory', () => {
  it('a Slack thread starts a session and creates no card', () => {
    const slack = read('integrations/slack/slack.js');
    expect(slack).toContain('sourceControl.sessions.create(');
    expect('await workItems.upsert({').toMatch(/workItems\.(upsert|create)\(/); // the pattern finds a real call
    expect(slack).not.toMatch(/upsertThreadWorkItem|workItems\.(upsert|create)\(/);
  });

  it('a card filed from a session goes through intake routing', () => {
    const tools = read('tools/work-item-tools.js');
    expect(tools).toContain('factory_create_work_item');
    const create = read('work-items/create-work-item.js');
    expect(create).toContain('resolveIntake(');
  });

  it("Work's Intake leads to Planning, never straight to Building", () => {
    const { intake, planning } = workBoard.phases;
    expect(workBoard.initialPhase).toBe('intake');
    expect(intake.kind).toBe('resting');
    expect(intake.nextPhases).toContain('planning');
    expect(intake.nextPhases).not.toContain('execute');
    expect(planning.kind).toBe('working');
    if (planning.kind !== 'working') return;
    expect(planning.exitTool).toEqual({ id: 'submit_plan', autoApprove: false });
  });

  it('Slack stays the only integration that provides channels', () => {
    // The Factory refuses to boot with two channels() providers (dist/factory.js).
    expect('channels' in SlackIntegration.prototype).toBe(true);
    expect('channels' in BeadsIntegration.prototype).toBe(false);
  });
});
