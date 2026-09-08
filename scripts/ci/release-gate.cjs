'use strict'

const REQUIRED_JOBS = ['go', 'rust', 'frontend', 'mobile', 'integration', 'workflow-policy']

async function verifyRelease({ github, owner, repo, sha, tag, allowMissingTag = false }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A full release commit SHA is required')
  const scope = { owner, repo }
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...scope,
    workflow_id: 'test.yml',
    head_sha: sha,
    branch: 'main',
    event: 'push',
    per_page: 100,
  })
  // Do not fall back to an older green run after a newer failure or rerun.
  const runs = data.workflow_runs.filter(run =>
    run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' &&
    run.path === '.github/workflows/test.yml')
  runs.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)
  const run = runs[0]
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Release blocked: latest main CI for ${sha} is missing or not successful`)
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...scope, run_id: run.id, filter: 'latest', per_page: 100,
  })
  for (const name of REQUIRED_JOBS) {
    const matches = jobs.filter(job => job.name === name)
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      throw new Error(`Release blocked: required job ${name} did not succeed for ${sha}`)
    }
  }
  if (tag) {
    let object
    try {
      object = (await github.rest.git.getRef({ ...scope, ref: `tags/${tag}` })).data.object
    } catch (error) {
      if (error.status !== 404 || !allowMissingTag) throw error
    }
    if (object) {
      for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
        object = (await github.rest.git.getTag({ ...scope, tag_sha: object.sha })).data.object
      }
      if (object.type !== 'commit' || object.sha !== sha) {
        throw new Error(`Release blocked: tag ${tag} does not point to validated commit ${sha}`)
      }
    }
  }
  return { sha, runId: run.id, runAttempt: run.run_attempt, url: run.html_url }
}

module.exports = { verifyRelease, REQUIRED_JOBS }
