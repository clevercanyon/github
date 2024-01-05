/**
 * C10n pre-processing plugin.
 *
 * Vite is not aware of this config file's location.
 *
 * @note PLEASE DO NOT EDIT THIS FILE!
 * @note This entire file will be updated automatically.
 * @note Instead of editing here, please review <https://github.com/clevercanyon/skeleton>.
 */

import fs from 'node:fs';
import path from 'node:path';
import { $chalk } from '../../../../../node_modules/@clevercanyon/utilities.node/dist/index.js';
import u from '../../../bin/includes/utilities.mjs';

/**
 * Configures Vite pre-processing plugin.
 *
 * @param   props Props from vite config file driver.
 *
 * @returns       Plugin configuration.
 */
export default async ({ command, isSSRBuild, projDir, distDir, appType }) => {
    return {
        name: 'vite-plugin-c10n-pre-processing',
        enforce: 'pre', // Before others on this hook.

        // By 'pre', we mean before writing bundle to disk.
        // i.e., The `buildEnd` hook fires before writing to disk.
        buildEnd(error) {
            if (error) return; // Not applicable.

            const maybeEmptyDistDir = () => {
                    if ('build' !== command || isSSRBuild) return;
                    if (!distDir || !fs.existsSync(distDir)) return;

                    if (['spa', 'mpa'].includes(appType)) {
                        // Preserving this, as Wrangler saves a few important-ish things here.
                        const wranglerCacheDir = path.resolve(distDir, './node_modules/.cache/wrangler');

                        if (fs.existsSync(wranglerCacheDir)) {
                            const tmpDir = fs.mkdtempSync(path.resolve(projDir, './.~c10n-')),
                                wranglerTmpCacheDir = path.resolve(tmpDir, './tGuaPyXd');

                            u.log($chalk.gray('Preserving `./node_modules/.cache/wrangler`.'));
                            fs.renameSync(wranglerCacheDir, wranglerTmpCacheDir);

                            resetDistDir(); // Resets `./dist` directory.

                            u.log($chalk.gray('Restoring `./node_modules/.cache/wrangler`.'));
                            fs.mkdirSync(path.dirname(wranglerCacheDir), { recursive: true });
                            fs.renameSync(wranglerTmpCacheDir, wranglerCacheDir);
                            fs.rmSync(tmpDir, { force: true, recursive: true });

                            return; // Done; stop here.
                        }
                    }
                    resetDistDir(); // Resets `./dist` directory.
                },
                resetDistDir = () => {
                    u.log($chalk.gray('Resetting `./' + path.relative(projDir, distDir) + '` directory.'));
                    fs.rmSync(distDir, { force: true, recursive: true });
                };

            maybeEmptyDistDir(); // Empties `./dist` directory prior to a new bundle being written to disk.
        },
    };
};