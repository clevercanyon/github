#!/usr/bin/env node
/**
 * Update CLI.
 *
 * @note PLEASE DO NOT EDIT THIS FILE!
 * @note This entire file will be updated automatically.
 * @note Instead of editing here, please review <https://github.com/clevercanyon/skeleton>.
 */
/* eslint-env es2021, node */

import _ from 'lodash';

import os from 'node:os';

import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'desm';
import fsp from 'node:fs/promises';

import * as se from 'shescape';
import spawn from 'spawn-please';

import coloredBox from 'boxen';
import terminalImage from 'term-img';
import chalk, { supportsColor } from 'chalk';

import semver from 'semver';
import prettier from 'prettier';
import dotenvVaultCore from 'dotenv-vault-core';

import { Octokit as OctokitCore } from '@octokit/core';
import { paginateRest as OctokitPluginPaginateRest } from '@octokit/plugin-paginate-rest';
import sodium from 'libsodium-wrappers'; // Used to encrypt GitHub secret values.

const __dirname = dirname(import.meta.url);
const binDir = path.resolve(__dirname, '..');
const projDir = path.resolve(__dirname, '../../../..');

const { pkgFile, pkgName, pkgPrivate, pkgRepository } = (() => {
	const pkgFile = path.resolve(projDir, './package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgFile).toString());

	if (typeof pkg !== 'object') {
		throw new Error('u: Unable to parse `./package.json`.');
	}
	const pkgName = pkg.name || '';
	const pkgPrivate = pkg.private;
	const pkgRepository = pkg.repository || '';

	return { pkgFile, pkgName, pkgPrivate, pkgRepository };
})();
const { log } = console; // Shorter reference.
const echo = process.stdout.write.bind(process.stdout);

const Octokit = OctokitCore.plugin(OctokitPluginPaginateRest);
const octokit = new Octokit({ auth: process.env.USER_GITHUB_TOKEN || '' });

const envFiles = {
	main: path.resolve(projDir, './dev/.envs/.env'),
	dev: path.resolve(projDir, './dev/.envs/.env.dev'),
	ci: path.resolve(projDir, './dev/.envs/.env.ci'),
	stage: path.resolve(projDir, './dev/.envs/.env.stage'),
	prod: path.resolve(projDir, './dev/.envs/.env.prod'),
};
const githubConfigVersion = '1.0.1'; // Bump when config changes in routines below.
const githubEnvsVersion = '1.0.0'; // Bump when environments change in routines below.
const npmjsConfigVersion = '1.0.0'; // Bump when config changes in routines below.

const c10nLogo = path.resolve(__dirname, '../../assets/brands/c10n/logo.png');
const c10nLogoDev = path.resolve(__dirname, '../../assets/brands/c10n/logo-dev.png');

/**
 * Utilities.
 */
export default class u {
	/*
	 * String utilities.
	 */

	static escRegExp(str) {
		return str.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	}

	/*
	 * TTY utilities.
	 */

	static async isInteractive() {
		const isTTY = process.stdout.isTTY || process.env.PARENT_IS_TTY ? true : false;
		return isTTY && process.env.TERM && 'dumb' !== process.env.TERM && 'true' !== process.env.CI && true !== process.env.CI;
	}

	/**
	 * Spawn utilities.
	 */

	static async spawn(cmd, args = [], opts = {}) {
		if ('shell' in opts ? opts.shell : 'bash') {
			// When using a shell, we must escape everything ourselves.
			// i.e., Node does not escape `cmd` or `args` when a `shell` is given.
			(cmd = se.quote(cmd)), (args = se.quoteAll(args));
		}
		return await spawn(cmd, args, {
			cwd: projDir,
			shell: 'bash',
			stdio: 'pipe',
			env: {
				...process.env,
				PARENT_IS_TTY:
					process.stdout.isTTY || //
					process.env.PARENT_IS_TTY
						? true
						: false,
			},
			// Output handlers do not run when `stdio: 'inherit'` or `quiet: true`.
			stdout: opts.quiet ? null : (buffer) => echo(chalk.white(buffer.toString())),
			stderr: opts.quiet ? null : (buffer) => echo(chalk.gray(buffer.toString())),

			..._.omit(opts, ['quiet']),
		});
	}

	/*
	 * Pkg utilities.
	 */

	static async pkg() {
		const pkg = JSON.parse(fs.readFileSync(pkgFile).toString());

		if (typeof pkg !== 'object') {
			throw new Error('u.pkg: Unable to parse `./package.json`.');
		}
		return pkg; // JSON object data.
	}

	static async isPkgRepo(ownerRepo) {
		return new RegExp('[:/]' + u.escRegExp(ownerRepo) + '(?:\\.git)?$', 'iu').test(pkgRepository);
	}

	static async isPkgRepoTemplate() {
		return /[:/][^/]+\/skeleton(?:\.[^/]+)?(?:\.git)?$/gi.test(pkgRepository);
	}

	static async pkgIncrementVersion(opts = { dryRun: false }) {
		const pkg = await u.pkg(); // Parses current `./package.json` file.

		const origVersion = String(pkg.version || '');
		let version = origVersion || '0.0.0';

		if (!semver.valid(version)) {
			throw new Error('u.pkgIncrementVersion: Not a semantic version: `' + origVersion + '`.');
		}
		const isVersionPrerelease = semver.prerelease(version) ? true : false;
		version = semver.inc(version, isVersionPrerelease ? 'prerelease' : 'patch');

		if (!version /* Catch increment failures. */) {
			throw new Error('u.pkgIncrementVersion: Failed to increment version: `' + origVersion + '`.');
		}
		if (!opts.dryRun) {
			pkg.version = version; // Update to incremented version.
			const pkgPrettierCfg = { ...(await prettier.resolveConfig(pkgFile)), parser: 'json' };
			await fsp.writeFile(pkgFile, prettier.format(JSON.stringify(pkg, null, 4), pkgPrettierCfg));
		}
	}

	static async prettifyPkg() {
		const pkg = await u.pkg(); // Parses current `./package.json` file.
		const pkgPrettierCfg = { ...(await prettier.resolveConfig(pkgFile)), parser: 'json' };
		await fsp.writeFile(pkgFile, prettier.format(JSON.stringify(pkg, null, 4), pkgPrettierCfg));
	}

	/*
	 * Git utilities.
	 */

	static async isGitRepo() {
		try {
			return 'true' === String(await u.spawn('git', ['rev-parse', '--is-inside-work-tree'], { quiet: true })).trim();
		} catch {
			return false;
		}
	}

	static async isGitRepoDirty() {
		return '' !== (await u.gitStatus({ short: true }));
	}

	static async isGitRepoOriginGitHub() {
		try {
			const { owner, repo } = await u.githubOrigin();
			return owner && repo ? true : false;
		} catch {
			return false;
		}
	}

	static async gitStatus(opts = { short: false }) {
		return String(await u.spawn('git', ['status', ...(opts.short ? ['--short'] : []), '--porcelain'], { quiet: true })).trim();
	}

	static async gitCurrentBranch() {
		const branch = String(await u.spawn('git', ['symbolic-ref', '--short', '--quiet', 'HEAD'], { quiet: true })).trim();

		if (!branch) {
			// In the case of being on a tag or a specific commit SHA.
			throw new Error('u.gitCurrentBranch: Not currently on any git branch.');
		}
		return branch;
	}

	static async gitAddCommitTagPush(message) {
		await u.gitAddCommitTag(message);
		await u.gitPush();
	}

	static async gitAddCommitPush(message) {
		await u.gitAddCommit(message);
		await u.gitPush();
	}

	static async gitAddCommitTag(message) {
		await u.gitAddCommit(message);
		await u.gitTag(message);
	}

	static async gitAddCommit(message) {
		await u.spawn('git', ['add', '--all']);
		await u.spawn('git', ['commit', '--message', message + (/\]$/u.test(message) ? '' : ' ') + '[robotic]']);
	}

	static async gitTag(message) {
		const pkg = await u.pkg(); // Parses current `./package.json` file.

		if (!pkg.version) {
			throw new Error('u.gitTag: Package version is empty.');
		}
		await u.spawn('git', ['tag', '--annotate', 'v' + pkg.version, '--message', message + (/\]$/u.test(message) ? '' : ' ') + '[robotic]']);
	}

	static async gitPush() {
		await u.spawn('git', ['push', '--set-upstream', 'origin', await u.gitCurrentBranch()]);
		await u.spawn('git', ['push', 'origin', '--tags']);
	}

	static async gitLocalRepoSHA(repoDir, branch) {
		return String(await u.spawn('git', ['rev-parse', branch], { cwd: repoDir, quiet: true }))
			.trim()
			.toLowerCase();
	}

	static async gitRemoteRepoSHA(repoURI, branch) {
		return String(await u.spawn('git', ['ls-remote', repoURI, branch], { cwd: os.tmpdir(), quiet: true }))
			.trim()
			.toLowerCase()
			.split(/\s+/u)[0];
	}

	/*
	 * GitHub utilities.
	 */

	static async githubOrigin() {
		let m = null; // Initialize array of matches.
		const url = String(await u.spawn('git', ['remote', 'get-url', 'origin'], { quiet: true })).trim();

		if ((m = /^https?:\/\/github.com\/([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(url))) {
			return { owner: m[1], repo: m[2] };
		} else if ((m = /^git@github(?:\.com)?:([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(url))) {
			return { owner: m[1], repo: m[2] };
		}
		throw new Error('u.githubOrigin: Repo does not have a GitHub origin.');
	}

	static async githubReleaseTag() {
		const { owner, repo } = await u.githubOrigin();

		// Created by Vite build process.
		const distZipFile = path.resolve(projDir, './.~dist.zip');

		if (!fs.existsSync(distZipFile)) {
			throw new Error('u.githubReleaseTag: Missing `./.~dist.zip`.');
		}
		const pkg = await u.pkg(); // Parses current `./package.json` file.

		if (!pkg.version) {
			throw new Error('u.githubReleaseTag: Package version is empty.');
		}
		const r = await octokit.request('POST /repos/{owner}/{repo}/releases', {
			owner,
			repo,

			name: 'v' + pkg.version,
			tag_name: 'v' + pkg.version,

			draft: false,
			generate_release_notes: true,
			prerelease: semver.prerelease(pkg.version) ? true : false,
		});
		if (typeof r !== 'object' || typeof r.data !== 'object' || !r.data.id || !r.data.upload_url) {
			throw new Error('u.githubReleaseTag: Failed to acquire GitHub release data.');
		}
		await octokit.request({
			method: 'POST',
			url: r.data.upload_url,

			name: 'dist.zip',
			headers: {
				'content-type': 'application/zip',
				'content-length': fs.statSync(distZipFile).size,
			},
			data: fs.readFileSync(distZipFile),
		});
	}

	static async githubCheckRepoOrgWideStandards(opts = { dryRun: false }) {
		const { owner, repo } = await u.githubOrigin();
		const repoData = await u._githubRepo();

		if ('Organization' !== repoData.owner?.type) {
			return; // Repo is not part of an organization.
		}
		if ('clevercanyon' !== repoData.organization?.login) {
			return; // Repo not in the `clevercanyon` organization.
		}
		if (!repoData.permissions?.admin) {
			return; // Current user’s permissions do not allow repo configuration.
		}
		const pkg = await u.pkg(); // Parses current `./package.json` file.

		if (_.get(pkg, 'config.c10n.&.github.configVersion') === githubConfigVersion) {
			log(chalk.gray('GitHub repo configuration is up-to-date @v' + githubConfigVersion + '.'));
			return; // Repo configuration version is already up-to-date.
		}
		if ('main' !== repoData.default_branch) {
			throw new Error('githubCheckRepoOrgWideStandards: Default branch at GitHub must be `main`.');
		}
		const alwaysOnRequiredLabels = {
			'bug report': {
				color: 'b60205',
				desc: 'Something isn’t working.',
			},
			'good first issue': {
				color: 'fef2c0',
				desc: 'Good first issue for newcomers.',
			},
			'question': {
				color: '0e8a16',
				desc: 'Something is being asked.',
			},
			'request': {
				color: '1d76db',
				desc: 'Something is being requested.',
			},
			'robotic': {
				color: 'eeeeee',
				desc: 'Something created robotically.',
			},
			'suggestion': {
				color: 'fbca04',
				desc: 'Something is being suggested.',
			},
		};
		const labels = Object.assign({}, _.get(pkg, 'config.c10n.&.github.labels', {}), alwaysOnRequiredLabels);
		const labelsToDelete = await u._githubRepoLabels(); // Current list of repo’s labels.

		const alwaysOnRequiredTeams = { owners: 'admin', 'security-managers': 'pull' }; // No exceptions.
		const teams = Object.assign({}, _.get(pkg, 'config.c10n.&.github.teams', {}), alwaysOnRequiredTeams);
		const teamsToDelete = await u._githubRepoTeams(); // Current list of repo’s teams.

		const protectedBranches = await u._githubRepoProtectedBranches();
		const protectedBranchesToDelete = Object.assign({}, protectedBranches);

		const defaultHomepage = 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '#readme';
		const defaultDescription = 'Another great project by @' + repoData.owner.login + '.';

		log(chalk.gray('Configuring GitHub repo using org-wide standards.'));
		if (!opts.dryRun) {
			await octokit.request('PATCH /repos/{owner}/{repo}', {
				owner,
				repo,

				has_wiki: true,
				has_issues: true,
				has_projects: true,
				has_discussions: true,
				has_downloads: true,

				// allow_forking: false,
				// Cannot configure this via API.
				// Disabled already by org @ GitHub.com.

				allow_auto_merge: false,
				allow_squash_merge: true,
				allow_merge_commit: false,
				allow_rebase_merge: false,
				allow_update_branch: true,
				delete_branch_on_merge: true,

				merge_commit_title: 'MERGE_MESSAGE',
				merge_commit_message: 'PR_TITLE',

				squash_merge_commit_title: 'PR_TITLE',
				squash_merge_commit_message: 'COMMIT_MESSAGES',

				web_commit_signoff_required: false,

				homepage: pkg.homepage || defaultHomepage,
				description: pkg.description || defaultDescription,

				is_template: await u.isPkgRepoTemplate(),
			});
			await octokit.request('PUT /repos/{owner}/{repo}/vulnerability-alerts', { owner, repo });
			await octokit.request('PUT /repos/{owner}/{repo}/automated-security-fixes', { owner, repo });
		}

		for (const [labelName, labelData] of Object.entries(labels)) {
			if (labelsToDelete[labelName]) {
				delete labelsToDelete[labelName]; // Don't delete.

				log(chalk.gray('Updating `' + labelName + '` label in GitHub repo to `#' + labelData.color + '` color.'));
				if (!opts.dryRun) {
					await octokit.request('PATCH /repos/{owner}/{repo}/labels/{labelName}', { owner, repo, labelName, ...labelData });
				}
			} else {
				log(chalk.gray('Adding `' + labelName + '` label to GitHub repo with `#' + labelData.color + '` color.'));
				if (!opts.dryRun) {
					await octokit.request('POST /repos/{owner}/{repo}/labels', { owner, repo, name: labelName, ...labelData });
				}
			}
		}
		for (const [labelName, labelData] of Object.entries(labelsToDelete)) {
			log(chalk.gray('Deleting `' + labelName + '` (unused) label with `#' + labelData.color + '` color from GitHub repo.'));
			if (!opts.dryRun) {
				await octokit.request('DELETE /repos/{owner}/{repo}/labels/{labelName}', { owner, repo, labelName });
			}
		}

		for (const [team, permission] of Object.entries(teams)) {
			delete teamsToDelete[team]; // Don't delete.

			log(chalk.gray('Adding `' + team + '` team to GitHub repo with `' + permission + '` permission.'));
			if (!opts.dryRun) {
				await octokit.request('PUT /orgs/{org}/teams/{team}/repos/{owner}/{repo}', { org: owner, owner, repo, team, permission });
			}
		}
		for (const [team, teamData] of Object.entries(teamsToDelete)) {
			log(chalk.gray('Deleting `' + team + '` (unused) team with `' + teamData.permission + '` permission from GitHub repo.'));
			if (!opts.dryRun) {
				await octokit.request('DELETE /orgs/{org}/teams/{team}/repos/{owner}/{repo}', { org: owner, owner, repo, team });
			}
		}

		for (const branch of ['main'] /* Always protect `main` branch. */) {
			delete protectedBranchesToDelete[branch]; // Don't delete.

			log(chalk.gray('Protecting `' + branch + '` branch in GitHub repo.'));
			if (!opts.dryRun) {
				await octokit.request('PUT /repos/{owner}/{repo}/branches/{branch}/protection', {
					owner,
					repo,
					branch,

					lock_branch: false,
					block_creations: true,
					allow_deletions: false,
					allow_fork_syncing: false,
					allow_force_pushes: false,

					required_signatures: true,
					required_linear_history: true,
					required_conversation_resolution: true,
					required_status_checks: null, // We don't use.

					// @review Not implemented. See: <https://o5p.me/hfPAag>.
					// Not currently a major issue since we already have an org-wide required workflow.
					required_deployment_environments: { environments: ['ci'] },

					restrictions: { users: [], teams: ['owners'], apps: [] },
					required_pull_request_reviews: {
						dismiss_stale_reviews: true,
						require_code_owner_reviews: true,
						required_approving_review_count: 1,
						require_last_push_approval: true,
						dismissal_restrictions: { users: [], teams: ['owners'], apps: [] },
						bypass_pull_request_allowances: { users: [], teams: ['owners'], apps: [] },
					},
					enforce_admins: false, // No. Let's not get too crazy.
				});
			}
		}
		for (const [branch] of Object.entries(protectedBranchesToDelete)) {
			log(chalk.gray('Deleting `' + branch + '` (unused) branch protection in GitHub repo.'));
			if (!opts.dryRun) {
				await octokit.request('DELETE /repos/{owner}/{repo}/branches/{branch}/protection', { owner, repo, branch });
			}
		}
		if (!opts.dryRun) {
			_.set(pkg, 'config.c10n.&.github.configVersion', githubConfigVersion);
			const pkgPrettierCfg = { ...(await prettier.resolveConfig(pkgFile)), parser: 'json' };
			await fsp.writeFile(pkgFile, prettier.format(JSON.stringify(pkg, null, 4), pkgPrettierCfg));
		}
	}

	static async githubPushRepoEnvs(opts = { dryRun: false }) {
		const { id: repoId, ...repoData } = await u._githubRepo();

		if ('Organization' !== repoData.owner?.type) {
			return; // Repo is not part of an organization.
		}
		if ('clevercanyon' !== repoData.organization?.login) {
			return; // Repo not in the `clevercanyon` organization.
		}
		if (!repoData.permissions?.admin) {
			return; // Current user’s permissions do not allow.
		}
		const pkg = await u.pkg(); // Parses current `./package.json` file.

		if (_.get(pkg, 'config.c10n.&.github.envsVersion') === githubEnvsVersion) {
			log(chalk.gray('GitHub repo environments are up-to-date @v' + githubEnvsVersion + '.'));
			return; // Repo environments version is already up-to-date.
		}
		log(chalk.gray('Configuring GitHub repo environments using org-wide standards.'));

		const envKeys = await u._envsExtractKeys(); // Dotenv Vault decryption keys.
		await u._githubEnsureRepoEnvs({ dryRun: opts.dryRun }); // Creates|deletes repo envs.

		for (const [envName] of Object.entries(_.omit(envFiles, ['main']))) {
			const envSecretsToDelete = await u._githubRepoEnvSecrets(repoId, envName);

			for (const [envSecretName, envSecretValue] of Object.entries({
				['USER_DOTENV_KEY_MAIN']: envKeys.main,
				['USER_DOTENV_KEY_' + envName.toUpperCase()]: envKeys[envName],
			})) {
				delete envSecretsToDelete[envSecretName]; // Don't delete.
				const { envPublicKeyId, envPublicKey } = await u._githubRepoEnvPublicKey(repoId, envName);

				const encryptedEnvSecretValue = await sodium.ready.then(() => {
					const sodiumKey = sodium.from_base64(envPublicKey, sodium.base64_variants.ORIGINAL);
					return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(envSecretValue), sodiumKey), sodium.base64_variants.ORIGINAL);
				});
				log(chalk.gray('Updating `' + envSecretName + '` secret in `' + envName + '` repo env at GitHub.'));
				if (!opts.dryRun) {
					await octokit.request('PUT /repositories/{repoId}/environments/{envName}/secrets/{envSecretName}', {
						repoId,
						envName,
						envSecretName,
						key_id: envPublicKeyId,
						encrypted_value: encryptedEnvSecretValue,
					});
				}
			}
			for (const [envSecretName] of Object.entries(envSecretsToDelete)) {
				log(chalk.gray('Deleting `' + envSecretName + '` (unused) secret in `' + envName + '` repo env at GitHub.'));
				if (!opts.dryRun) {
					await octokit.request('DELETE /repositories/{repoId}/environments/{envName}/secrets/{envSecretName}', { repoId, envName, envSecretName });
				}
			}
		}
		if (!opts.dryRun) {
			_.set(pkg, 'config.c10n.&.github.envsVersion', githubEnvsVersion);
			const pkgPrettierCfg = { ...(await prettier.resolveConfig(pkgFile)), parser: 'json' };
			await fsp.writeFile(pkgFile, prettier.format(JSON.stringify(pkg, null, 4), pkgPrettierCfg));
		}
	}

	static async _githubRepo() {
		const { owner, repo } = await u.githubOrigin();
		const r = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });

		if (typeof r !== 'object' || typeof r.data !== 'object' || !r.data.id) {
			throw new Error('u._githubRepo: Failed to acquire GitHub repository’s data.');
		}
		return r.data;
	}

	static async _githubRepoLabels() {
		const labels = {}; // Initialize.
		const { owner, repo } = await u.githubOrigin();
		const i6r = octokit.paginate.iterator('GET /repos/{owner}/{repo}/labels{?per_page}', { owner, repo, per_page: 100 });

		if (typeof i6r !== 'object') {
			throw new Error('u._githubRepoLabels: Failed to acquire GitHub repository’s labels.');
		}
		for await (const { data } of i6r) {
			for (const label of data) {
				if (typeof label !== 'object' || !label.name) {
					throw new Error('u._githubRepoLabels: Failed to acquire GitHub repository’s label data.');
				}
				labels[label.name] = label;
			}
		}
		return labels;
	}

	static async _githubRepoTeams() {
		const repoTeams = {}; // Initialize.
		const { owner, repo } = await u.githubOrigin();
		const i6r = octokit.paginate.iterator('GET /repos/{owner}/{repo}/teams{?per_page}', { owner, repo, per_page: 100 });

		if (typeof i6r !== 'object') {
			throw new Error('u._githubRepoTeams: Failed to acquire GitHub repository’s teams.');
		}
		for await (const { data } of i6r) {
			for (const repoTeam of data) {
				if (typeof repoTeam !== 'object' || !repoTeam.slug) {
					throw new Error('u._githubRepoTeams: Failed to acquire a GitHub repo team’s data.');
				}
				repoTeams[repoTeam.slug] = repoTeam;
			}
		}
		return repoTeams;
	}

	static async _githubRepoProtectedBranches() {
		const repoProtectedBranches = {};
		const { owner, repo } = await u.githubOrigin();
		const i6r = octokit.paginate.iterator('GET /repos/{owner}/{repo}/branches{?protected,per_page}', { owner, repo, protected: true, per_page: 100 });

		if (typeof i6r !== 'object') {
			throw new Error('u._githubRepoProtectedBranches: Failed to acquire GitHub repository’s protected branches.');
		}
		for await (const { data } of i6r) {
			for (const repoProtectedBranch of data) {
				if (typeof repoProtectedBranch !== 'object' || !repoProtectedBranch.name) {
					throw new Error('u._githubRepoProtectedBranches: Failed to acquire a GitHub repository’s protected branch data.');
				}
				repoProtectedBranches[repoProtectedBranch.name] = repoProtectedBranch;
			}
		}
		return repoProtectedBranches;
	}

	static async _githubRepoEnvs() {
		const envs = {}; // Initialize.
		const { owner, repo } = await u.githubOrigin();
		const i6r = octokit.paginate.iterator('GET /repos/{owner}/{repo}/environments{?per_page}', { owner, repo, per_page: 100 });

		if (typeof i6r !== 'object') {
			throw new Error('u._githubRepoEnvs: Failed to acquire GitHub repository’s environments.');
		}
		for await (const { data } of i6r) {
			for (const env of data) {
				if (typeof env !== 'object' || !env.name) {
					throw new Error('u._githubRepoEnvs: Failed to acquire GitHub repository’s environment data.');
				}
				envs[env.name] = env;
			}
		}
		return envs;
	}

	static async _githubRepoEnvPublicKey(repoId, envName) {
		const r = await octokit.request('GET /repositories/{repoId}/environments/{envName}/secrets/public-key', { repoId, envName });

		if (typeof r !== 'object' || typeof r.data !== 'object' || !r.data.key_id || !r.data.key) {
			throw new Error('u._githubRepoEnvPublicKey: Failed to acquire GitHub repository env’s public key.');
		}
		return { envPublicKeyId: r.data.key_id, envPublicKey: r.data.key };
	}

	static async _githubRepoEnvSecrets(repoId, envName) {
		const envSecrets = {}; // Initialize.
		const i6r = octokit.paginate.iterator('GET /repositories/{repoId}/environments/{envName}/secrets{?per_page}', { repoId, envName, per_page: 100 });

		if (typeof i6r !== 'object') {
			throw new Error('u._githubRepoEnvSecrets: Failed to acquire GitHub repository’s secrets for an environment.');
		}
		for await (const { data } of i6r) {
			for (const envSecret of data) {
				if (typeof envSecret !== 'object' || !envSecret.name) {
					throw new Error('u._githubRepoEnvSecrets: Failed to acquire GitHub repository’s secret data for an environment.');
				}
				envSecrets[envSecret.name] = envSecret;
			}
		}
		return envSecrets;
	}

	static async _githubRepoEnvBranchPolicies(envName) {
		const envBranchPolicies = {}; // Initialize.
		const { owner, repo } = await u.githubOrigin();
		const i6r = octokit.paginate.iterator('GET /repos/{owner}/{repo}/environments/{envName}/deployment-branch-policies{?per_page}', { owner, repo, envName, per_page: 100 });

		if (typeof i6r !== 'object') {
			throw new Error('u._githubRepoEnvBranchPolicies: Failed to acquire GitHub repository’s branch policies for an environment.');
		}
		for await (const { data } of i6r) {
			for (const envBranchPolicy of data) {
				if (typeof envBranchPolicy !== 'object' || !envBranchPolicy.name) {
					throw new Error('u._githubRepoEnvBranchPolicies: Failed to acquire GitHub repository’s branch policy data for an environment.');
				}
				envBranchPolicies[envBranchPolicy.name] = envBranchPolicy;
			}
		}
		return envBranchPolicies;
	}

	static async _githubEnsureRepoEnvs(opts = { dryRun: false }) {
		const { owner, repo } = await u.githubOrigin();
		const repoEnvs = await u._githubRepoEnvs();
		const repoEnvsToDelete = Object.assign({}, repoEnvs);

		for (const [envName] of Object.entries(_.omit(envFiles, ['main']))) {
			delete repoEnvsToDelete[envName]; // Don't delete.

			if (repoEnvs[envName]) {
				log(chalk.gray('Updating `' + envName + '` repo env at GitHub.'));
			} else {
				log(chalk.gray('Creating `' + envName + '` repo env at GitHub.'));
			}
			if (!opts.dryRun) {
				await octokit.request('PUT /repos/{owner}/{repo}/environments/{envName}', {
					owner,
					repo,
					envName,
					deployment_branch_policy: {
						protected_branches: false,
						custom_branch_policies: true,
					},
				});
				const repoEnvBranchPolicies = await u._githubRepoEnvBranchPolicies(envName);
				const repoEnvBranchPoliciesToDelete = Object.assign({}, repoEnvBranchPolicies);

				for (const repoEnvBranchPolicyName of [...('prod' === envName ? ['main'] : [])]) {
					delete repoEnvBranchPoliciesToDelete[repoEnvBranchPolicyName]; // Don't delete.

					if (!repoEnvBranchPolicies[repoEnvBranchPolicyName]) {
						log(chalk.gray('Creating `' + repoEnvBranchPolicyName + '` branch policy for `' + envName + '` repo env at GitHub.'));
						if (!opts.dryRun) {
							await octokit.request('POST /repos/{owner}/{repo}/environments/{envName}/deployment-branch-policies', {
								owner,
								repo,
								envName,
								name: repoEnvBranchPolicyName,
							});
						}
					}
				}
				for (const [repoEnvBranchPolicyName, repoEnvBranchPolicy] of Object.entries(repoEnvBranchPoliciesToDelete)) {
					log(chalk.gray('Deleting `' + repoEnvBranchPolicyName + '` (unused) branch policy for `' + envName + '` repo env at GitHub.'));
					if (!opts.dryRun) {
						await octokit.request('DELETE /repos/{owner}/{repo}/environments/{envName}/deployment-branch-policies/{branchPolicyId}', {
							owner,
							repo,
							envName,
							branchPolicyId: repoEnvBranchPolicy.id,
						});
					}
				}
			}
		}
		for (const [envName] of Object.entries(repoEnvsToDelete)) {
			log(chalk.gray('Deleting `' + envName + '` (unused) repo env at GitHub.'));
			if (!opts.dryRun) {
				await octokit.request('DELETE /repos/{owner}/{repo}/environments/{envName}', { owner, repo, envName });
			}
		}
	}

	/*
	 * Env utilities.
	 */

	static async isEnvsVault() {
		return fs.existsSync(path.resolve(projDir, './.env.vault'));
	}

	static async envsPush(opts = { dryRun: false }) {
		for (const [envName, envFile] of Object.entries(envFiles)) {
			if (!fs.existsSync(envFile)) {
				log(chalk.gray('Creating file for `' + envName + '` env.'));
				if (!opts.dryRun) {
					await fsp.mkdir(path.dirname(envFile), { recursive: true });
					await fsp.writeFile(envFile, '# ' + envName);
				}
			}
			log(chalk.gray('Pushing `' + envName + '` env to Dotenv Vault.'));
			if (!opts.dryRun) {
				await u.spawn('npx', ['dotenv-vault', 'push', envName, envFile, '--yes']);
			}
		}
		log(chalk.gray('Encrypting all envs using latest Dotenv Vault data.'));
		if (!opts.dryRun) {
			await u.spawn('npx', ['dotenv-vault', 'build', '--yes']);
		}
		if ((await u.isGitRepo()) && (await u.isGitRepoOriginGitHub())) {
			await u.githubPushRepoEnvs({ dryRun: opts.dryRun });
		}
	}

	static async envsPull(opts = { dryRun: false }) {
		for (const [envName, envFile] of Object.entries(envFiles)) {
			log(chalk.gray('Pulling `' + envName + '` env from Dotenv Vault.'));
			if (!opts.dryRun) {
				await fsp.mkdir(path.dirname(envFile), { recursive: true });
				await u.spawn('npx', ['dotenv-vault', 'pull', envName, envFile, '--yes']);
			}
			// log(chalk.gray('Deleting previous file for `' + envName + '` env.'));
			if (!opts.dryRun) {
				await fsp.rm(envFile + '.previous', { force: true });
			}
		}
	}

	static async envsKeys(opts = { dryRun: false }) {
		log(chalk.gray('Getting all Dotenv Vault keys.'));
		if (!opts.dryRun) {
			await u.spawn('npx', ['dotenv-vault', 'keys', '--yes']);
		}
	}

	static async envsEncrypt(opts = { dryRun: false }) {
		log(chalk.gray('Building Dotenv Vault; i.e., encrypting all envs.'));
		if (!opts.dryRun) {
			await u.spawn('npx', ['dotenv-vault', 'build', '--yes']);
		}
	}

	static async envsDecrypt(opts = { keys: [], dryRun: false }) {
		for (const key of opts.keys) {
			const envName = key.split('?')[1]?.split('=')[1] || '';
			const envFile = envFiles[envName] || '';

			if (!envName || !envFile) {
				throw new Error('u.envsDecrypt: Invalid Dotenv Vault decryption key: `' + key + '`.');
			}
			log(chalk.gray('Decrypting `' + envName + '` env using Dotenv Vault key.'));
			if (!opts.dryRun) {
				const origDotenvKey = process.env.DOTENV_KEY || '';
				process.env.DOTENV_KEY = key; // For `dotEnvVaultCore`.

				// Note: `path` leads to `.env.vault`. See: <https://o5p.me/MqXJaf>.
				const { parsed: env } = dotenvVaultCore.config({ path: path.resolve(projDir, './.env' /* .vault */) });

				await fsp.mkdir(path.dirname(envFile), { recursive: true });
				await fsp.writeFile(envFile, await u._envsToString(envName, env));
				process.env.DOTENV_KEY = origDotenvKey;
			}
		}
	}

	static async envsInstallOrDecrypt(opts = { mode: 'prod' }) {
		if (!(await u.isInteractive()) /* Use keys. */) {
			const env = process.env; // Shorter reference.

			if (!env.USER_DOTENV_KEY_MAIN) {
				throw new Error('u.envsInstallOrDecrypt: Missing `USER_DOTENV_KEY_MAIN` environment variable.');
			}
			const keys = [env.USER_DOTENV_KEY_MAIN];

			if ('dev' === opts.mode) {
				if (!env.USER_DOTENV_KEY_DEV) {
					throw new Error('u.envsInstallOrDecrypt: Missing `USER_DOTENV_KEY_DEV` environment variable.');
				}
				keys.push(env.USER_DOTENV_KEY_DEV);
				//
			} else if ('ci' === opts.mode) {
				if (!env.USER_DOTENV_KEY_CI) {
					throw new Error('u.envsInstallOrDecrypt: Missing `USER_DOTENV_KEY_CI` environment variable.');
				}
				keys.push(env.USER_DOTENV_KEY_CI);
				//
			} else if ('stage' === opts.mode) {
				if (!env.USER_DOTENV_KEY_STAGE) {
					throw new Error('u.envsInstallOrDecrypt: Missing `USER_DOTENV_KEY_STAGE` environment variable.');
				}
				keys.push(env.USER_DOTENV_KEY_STAGE);
				//
			} else if ('prod' === opts.mode) {
				if (!env.USER_DOTENV_KEY_PROD) {
					throw new Error('u.envsInstallOrDecrypt: Missing `USER_DOTENV_KEY_PROD` environment variable.');
				}
				keys.push(env.USER_DOTENV_KEY_PROD);
			}
			await u.spawn(path.resolve(binDir, './envs.js'), ['decrypt', '--keys', ...keys]);
		} else {
			await u.spawn(path.resolve(binDir, './envs.js'), ['install']);
		}
	}

	static async _envsExtractKeys() {
		const keys = {}; // Initialize.

		log(chalk.gray('Extracting all Dotenv Vault keys.'));
		const output = await u.spawn('npx', ['dotenv-vault', 'keys', '--yes'], { quiet: true });

		let _m = null; // Initialize.
		const regexp = /\bdotenv:\/\/:key_.+?\?environment=([^\s]+)/giu;

		while ((_m = regexp.exec(output)) !== null) {
			keys[_m[1]] = _m[0];
		}
		if (Object.keys(keys).length !== Object.keys(envFiles).length) {
			throw new Error('u._envsExtractKeys: Failed to extract Dotenv Vault keys.');
		}
		return keys;
	}

	static async _envsToString(envName, env) {
		let str = '# ' + envName + '\n';

		for (let [name, value] of Object.entries(env)) {
			value = String(value);
			value = value.replace(/\r\n?/gu, '\n');
			value = value.replace(/\n/gu, '\\n');
			str += name + '="' + value.replace(/"/gu, '\\"') + '"\n';
		}
		return str;
	}

	static propagateUserEnvVars() {
		process.env.NPM_TOKEN = process.env.USER_NPM_TOKEN || '';
		process.env.GH_TOKEN = process.env.USER_GITHUB_TOKEN || '';
		process.env.GITHUB_TOKEN = process.env.USER_GITHUB_TOKEN || '';
		process.env.CLOUDFLARE_API_TOKEN = process.env.USER_CLOUDFLARE_TOKEN || '';
	}

	/*
	 * NPM utilities.
	 */

	static async isNPMPkg() {
		return (await u.isGitRepo()) && false === pkgPrivate;
	}

	static async isNPMPkgOriginNPMJS() {
		try {
			return (
				(await u.npmjsPkgOrigin()) && // Throws exception on failure.
				(await u.isNPMPkgRegistryNPMJS()) && // Confirms `https://registry.npmjs.org`.
				// This command throws an exception on failure; e.g., if package is not published at npmjs.
				(await u.spawn('npm', ['author', 'ls'], { quiet: true }).then(() => true)) // Published at npmjs?
			);
		} catch {
			return false;
		}
	}

	static async isNPMPkgRegistryNPMJS() {
		return await u.isNPMPkgRegistry('https://registry.npmjs.org');
	}

	static async isNPMPkgRegistry(registry) {
		return (
			registry.replace(/\/+$/, '') ===
			String(await u.spawn('npm', ['config', 'get', 'registry'], { quiet: true }))
				.trim()
				.replace(/\/+$/, '')
		);
	}

	static async isNPMPkgPublishable(opts = { mode: 'prod' }) {
		return (await u.isNPMPkg()) && 'main' === (await u.gitCurrentBranch()) && 'prod' === opts.mode;
	}

	static async npmInstall() {
		await u.spawn('npm', ['install'], { stdio: 'inherit' });
	}

	static async npmCleanInstall() {
		await u.spawn('npm', ['ci'], { stdio: 'inherit' });
	}

	static async npmUpdate() {
		await u.spawn('npm', ['update', '--save'], { stdio: 'inherit' });
		await u.prettifyPkg(); // To our standards.
	}

	static async npmPublish(opts = { dryRun: false }) {
		if (!opts.dryRun) {
			await u.spawn('npm', ['publish']);
		}
		if (await u.isNPMPkgOriginNPMJS()) {
			await u.npmjsCheckPkgOrgWideStandards({ dryRun: opts.dryRun });
		}
	}

	/*
	 * npmjs utilities.
	 */

	static async npmjsPkgOrigin() {
		let m = null; // Initialize array of matches.

		if ((m = /^(@[^/]+)\/([^/]+)$/iu.exec(pkgName))) {
			return { org: m[1], name: m[2] };
		} else if ((m = /^([^/]+)$/iu.exec(pkgName))) {
			return { org: '', name: m[1] };
		}
		throw new Error('u.npmjsPkgOrigin: Package does not have an npmjs origin.');
	}

	static async npmjsCheckPkgOrgWideStandards(opts = { dryRun: false }) {
		const { org } = await u.npmjsPkgOrigin();

		if ('@clevercanyon' !== org) {
			return; // Package not in the `@clevercanyon` organization.
		}
		if (!(await u._npmjsOrgUserCanAdmin(org))) {
			return; // Current user’s permissions do not allow package configuration.
		}
		const pkg = await u.pkg(); // Parses current `./package.json` file.

		if (_.get(pkg, 'config.c10n.&.npmjs.configVersions') === githubConfigVersion + ',' + npmjsConfigVersion) {
			log(chalk.gray('npmjs package configuration is up-to-date @v' + githubConfigVersion + ' @v' + npmjsConfigVersion + '.'));
			return; // Package configuration version is already up-to-date.
		}
		log(chalk.gray('Configuring npmjs package using org-wide standards.'));

		const teamsToDelete = await u._npmjsOrgTeams(org); // Current list of organization’s teams.
		const alwaysOnRequiredTeams = { developers: 'read-write', owners: 'read-write', 'security-managers': 'read-only' }; // No exceptions.

		const teams = Object.assign({}, _.get(pkg, 'config.c10n.&.npmjs.teams', _.get(pkg, 'config.c10n.&.github.teams', {})), alwaysOnRequiredTeams);
		Object.keys(teams).forEach((team) => (teams[team] = /^(?:read-write|push|maintain|admin)$/iu.test(teams[team]) ? 'read-write' : 'read-only'));

		for (const [team, permission] of Object.entries(teams)) {
			delete teamsToDelete[team]; // Don't delete.

			log(chalk.gray('Adding `' + team + '` team to npmjs package with `' + permission + '` permission.'));
			if (!opts.dryRun) {
				await u.spawn('npm', ['access', 'grant', permission, org + ':' + team], { quiet: true });
			}
		}
		for (const [team] of Object.entries(teamsToDelete)) {
			log(chalk.gray('Deleting `' + team + '` (unused) from npmjs package.'));
			if (!opts.dryRun) {
				await u.spawn('npm', ['access', 'revoke', org + ':' + team], { quiet: true }).catch(() => null);
			}
		}
		if (!opts.dryRun) {
			_.set(pkg, 'config.c10n.&.npmjs.configVersions', githubConfigVersion + ',' + npmjsConfigVersion);
			const pkgPrettierCfg = { ...(await prettier.resolveConfig(pkgFile)), parser: 'json' };
			await fsp.writeFile(pkgFile, prettier.format(JSON.stringify(pkg, null, 4), pkgPrettierCfg));
		}
	}

	static async _npmjsOrgUserCanAdmin(org) {
		try {
			return 'object' === typeof (await u._npmjsOrgUsers(org));
		} catch {
			return false; // Only admins|owners can list org members.
		}
	}

	static async _npmjsOrgUsers(org) {
		const members = JSON.parse(String(await u.spawn('npm', ['org', 'ls', org, '--json'], { quiet: true })));

		if (typeof members !== 'object') {
			throw new Error('u._npmjsOrgMembers: Failed to acquire list of NPM team members for `' + org + '`.');
		}
		return members; // Keyed by username; values one of: `developer`, `admin`, or `owner`.
	}

	static async _npmjsOrgTeams(org) {
		const teams = JSON.parse(String(await u.spawn('npm', ['team', 'ls', org, '--json'], { quiet: true })));

		if (!(teams instanceof Array)) {
			throw new Error('u._npmjsOrgTeams: Failed to acquire list of NPM teams for `' + org + '` org.');
		}
		return teams.reduce((o, team) => {
			o[team.replace(/^[^:]+:/u, '')] = team;
			return o; // Object return.
		}, {});
	}

	/*
	 * Vite utilities.
	 */

	static async viteBuild(opts = { mode: 'prod' }) {
		await u.spawn('npx', ['vite', 'build', '--mode', opts.mode]);
	}

	/**
	 * Error utilities.
	 */
	static async error(title, text) {
		if (!process.stdout.isTTY || !supportsColor?.has16m) {
			return chalk.red(text); // No box.
		}
		return (
			'\n' +
			coloredBox(chalk.bold.red(text), {
				margin: 0,
				padding: 0.75,
				textAlignment: 'left',

				dimBorder: false,
				borderStyle: 'round',
				borderColor: '#551819',
				backgroundColor: '',

				titleAlignment: 'left',
				title: chalk.bold.redBright('⚑ ' + title),
			}) +
			'\n' +
			(await terminalImage(c10nLogoDev, { width: '300px', fallback: () => '' }))
		);
	}

	/**
	 * Finale utilities.
	 */
	static async finale(title, text) {
		if (!process.stdout.isTTY || !supportsColor?.has16m) {
			return chalk.green(text); // No box.
		}
		return (
			'\n' +
			coloredBox(chalk.bold.hex('#ed5f3b')(text), {
				margin: 0,
				padding: 0.75,
				textAlignment: 'left',

				dimBorder: false,
				borderStyle: 'round',
				borderColor: '#8e3923',
				backgroundColor: '',

				titleAlignment: 'left',
				title: chalk.bold.green('✓ ' + title),
			}) +
			'\n' +
			(await terminalImage(c10nLogo, { width: '300px', fallback: () => '' }))
		);
	}
}