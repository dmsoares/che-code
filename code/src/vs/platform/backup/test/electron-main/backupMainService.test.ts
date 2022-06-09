/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { Schemas } from 'vs/base/common/network';
import * as path from 'vs/base/common/path';
import * as platform from 'vs/base/common/platform';
import { isEqual } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import * as pfs from 'vs/base/node/pfs';
import { flakySuite, getRandomTestPath } from 'vs/base/test/node/testUtils';
import { BackupMainService } from 'vs/platform/backup/electron-main/backupMainService';
import { IBackupWorkspacesFormat, ISerializedWorkspace } from 'vs/platform/backup/node/backup';
import { TestConfigurationService } from 'vs/platform/configuration/test/common/testConfigurationService';
import { EnvironmentMainService } from 'vs/platform/environment/electron-main/environmentMainService';
import { OPTIONS, parseArgs } from 'vs/platform/environment/node/argv';
import { HotExitConfiguration } from 'vs/platform/files/common/files';
import { ConsoleMainLogger, LogService } from 'vs/platform/log/common/log';
import product from 'vs/platform/product/common/product';
import { IFolderBackupInfo, isFolderBackupInfo, IWorkspaceBackupInfo } from 'vs/platform/backup/common/backup';
import { IWorkspaceIdentifier } from 'vs/platform/workspace/common/workspace';

flakySuite('BackupMainService', () => {

	function assertEqualFolderInfos(actual: IFolderBackupInfo[], expected: IFolderBackupInfo[]) {
		const withUriAsString = (f: IFolderBackupInfo) => ({ folderUri: f.folderUri.toString(), remoteAuthority: f.remoteAuthority });
		assert.deepStrictEqual(actual.map(withUriAsString), expected.map(withUriAsString));
	}

	function toWorkspace(path: string): IWorkspaceIdentifier {
		return {
			id: createHash('md5').update(sanitizePath(path)).digest('hex'),
			configPath: URI.file(path)
		};
	}

	function toWorkspaceBackupInfo(path: string, remoteAuthority?: string): IWorkspaceBackupInfo {
		return {
			workspace: {
				id: createHash('md5').update(sanitizePath(path)).digest('hex'),
				configPath: URI.file(path)
			},
			remoteAuthority
		};
	}

	function toFolderBackupInfo(uri: URI, remoteAuthority?: string): IFolderBackupInfo {
		return { folderUri: uri, remoteAuthority };
	}

	function toSerializedWorkspace(ws: IWorkspaceIdentifier): ISerializedWorkspace {
		return {
			id: ws.id,
			configURIPath: ws.configPath.toString()
		};
	}

	function ensureFolderExists(uri: URI): Promise<void> {
		if (!fs.existsSync(uri.fsPath)) {
			fs.mkdirSync(uri.fsPath);
		}

		const backupFolder = service.toBackupPath(uri);
		return createBackupFolder(backupFolder);
	}

	async function ensureWorkspaceExists(workspace: IWorkspaceIdentifier): Promise<IWorkspaceIdentifier> {
		if (!fs.existsSync(workspace.configPath.fsPath)) {
			await pfs.Promises.writeFile(workspace.configPath.fsPath, 'Hello');
		}

		const backupFolder = service.toBackupPath(workspace.id);
		await createBackupFolder(backupFolder);

		return workspace;
	}

	async function createBackupFolder(backupFolder: string): Promise<void> {
		if (!fs.existsSync(backupFolder)) {
			fs.mkdirSync(backupFolder);
			fs.mkdirSync(path.join(backupFolder, Schemas.file));
			await pfs.Promises.writeFile(path.join(backupFolder, Schemas.file, 'foo.txt'), 'Hello');
		}
	}

	function sanitizePath(p: string): string {
		return platform.isLinux ? p : p.toLowerCase();
	}

	const fooFile = URI.file(platform.isWindows ? 'C:\\foo' : '/foo');
	const barFile = URI.file(platform.isWindows ? 'C:\\bar' : '/bar');

	let service: BackupMainService & { toBackupPath(arg: URI | string): string; getFolderHash(folder: IFolderBackupInfo): string };
	let configService: TestConfigurationService;

	let environmentService: EnvironmentMainService;
	let testDir: string;
	let backupHome: string;
	let backupWorkspacesPath: string;
	let existingTestFolder1: URI;

	setup(async () => {
		testDir = getRandomTestPath(os.tmpdir(), 'vsctests', 'backupmainservice');
		backupHome = path.join(testDir, 'Backups');
		backupWorkspacesPath = path.join(backupHome, 'workspaces.json');
		existingTestFolder1 = URI.file(path.join(testDir, 'folder1'));

		environmentService = new EnvironmentMainService(parseArgs(process.argv, OPTIONS), { _serviceBrand: undefined, ...product });

		await pfs.Promises.mkdir(backupHome, { recursive: true });

		configService = new TestConfigurationService();
		service = new class TestBackupMainService extends BackupMainService {
			constructor() {
				super(environmentService, configService, new LogService(new ConsoleMainLogger()));

				this.backupHome = backupHome;
				this.workspacesJsonPath = backupWorkspacesPath;
			}

			toBackupPath(arg: URI | string): string {
				const id = arg instanceof URI ? super.getFolderHash({ folderUri: arg }) : arg;
				return path.join(this.backupHome, id);
			}

			override getFolderHash(folder: IFolderBackupInfo): string {
				return super.getFolderHash(folder);
			}
		};

		return service.initialize();
	});

	teardown(() => {
		return pfs.Promises.rm(testDir);
	});

	test('service validates backup workspaces on startup and cleans up (folder workspaces)', async function () {

		// 1) backup workspace path does not exist
		service.registerFolderBackupSync(toFolderBackupInfo(fooFile));
		service.registerFolderBackupSync(toFolderBackupInfo(barFile));
		await service.initialize();
		assertEqualFolderInfos(service.getFolderBackupPaths(), []);

		// 2) backup workspace path exists with empty contents within
		fs.mkdirSync(service.toBackupPath(fooFile));
		fs.mkdirSync(service.toBackupPath(barFile));
		service.registerFolderBackupSync(toFolderBackupInfo(fooFile));
		service.registerFolderBackupSync(toFolderBackupInfo(barFile));
		await service.initialize();
		assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		assert.ok(!fs.existsSync(service.toBackupPath(fooFile)));
		assert.ok(!fs.existsSync(service.toBackupPath(barFile)));

		// 3) backup workspace path exists with empty folders within
		fs.mkdirSync(service.toBackupPath(fooFile));
		fs.mkdirSync(service.toBackupPath(barFile));
		fs.mkdirSync(path.join(service.toBackupPath(fooFile), Schemas.file));
		fs.mkdirSync(path.join(service.toBackupPath(barFile), Schemas.untitled));
		service.registerFolderBackupSync(toFolderBackupInfo(fooFile));
		service.registerFolderBackupSync(toFolderBackupInfo(barFile));
		await service.initialize();
		assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		assert.ok(!fs.existsSync(service.toBackupPath(fooFile)));
		assert.ok(!fs.existsSync(service.toBackupPath(barFile)));

		// 4) backup workspace path points to a workspace that no longer exists
		// so it should convert the backup worspace to an empty workspace backup
		const fileBackups = path.join(service.toBackupPath(fooFile), Schemas.file);
		fs.mkdirSync(service.toBackupPath(fooFile));
		fs.mkdirSync(service.toBackupPath(barFile));
		fs.mkdirSync(fileBackups);
		service.registerFolderBackupSync(toFolderBackupInfo(fooFile));
		assert.strictEqual(service.getFolderBackupPaths().length, 1);
		assert.strictEqual(service.getEmptyWindowBackupPaths().length, 0);
		fs.writeFileSync(path.join(fileBackups, 'backup.txt'), '');
		await service.initialize();
		assert.strictEqual(service.getFolderBackupPaths().length, 0);
		assert.strictEqual(service.getEmptyWindowBackupPaths().length, 1);
	});

	test('service validates backup workspaces on startup and cleans up (root workspaces)', async function () {

		// 1) backup workspace path does not exist
		service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(fooFile.fsPath));
		service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(barFile.fsPath));
		await service.initialize();
		assert.deepStrictEqual(service.getWorkspaceBackups(), []);

		// 2) backup workspace path exists with empty contents within
		fs.mkdirSync(service.toBackupPath(fooFile));
		fs.mkdirSync(service.toBackupPath(barFile));
		service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(fooFile.fsPath));
		service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(barFile.fsPath));
		await service.initialize();
		assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		assert.ok(!fs.existsSync(service.toBackupPath(fooFile)));
		assert.ok(!fs.existsSync(service.toBackupPath(barFile)));

		// 3) backup workspace path exists with empty folders within
		fs.mkdirSync(service.toBackupPath(fooFile));
		fs.mkdirSync(service.toBackupPath(barFile));
		fs.mkdirSync(path.join(service.toBackupPath(fooFile), Schemas.file));
		fs.mkdirSync(path.join(service.toBackupPath(barFile), Schemas.untitled));
		service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(fooFile.fsPath));
		service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(barFile.fsPath));
		await service.initialize();
		assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		assert.ok(!fs.existsSync(service.toBackupPath(fooFile)));
		assert.ok(!fs.existsSync(service.toBackupPath(barFile)));

		// 4) backup workspace path points to a workspace that no longer exists
		// so it should convert the backup worspace to an empty workspace backup
		const fileBackups = path.join(service.toBackupPath(fooFile), Schemas.file);
		fs.mkdirSync(service.toBackupPath(fooFile));
		fs.mkdirSync(service.toBackupPath(barFile));
		fs.mkdirSync(fileBackups);
		service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(fooFile.fsPath));
		assert.strictEqual(service.getWorkspaceBackups().length, 1);
		assert.strictEqual(service.getEmptyWindowBackupPaths().length, 0);
		fs.writeFileSync(path.join(fileBackups, 'backup.txt'), '');
		await service.initialize();
		assert.strictEqual(service.getWorkspaceBackups().length, 0);
		assert.strictEqual(service.getEmptyWindowBackupPaths().length, 1);
	});

	test('service supports to migrate backup data from another location', () => {
		const backupPathToMigrate = service.toBackupPath(fooFile);
		fs.mkdirSync(backupPathToMigrate);
		fs.writeFileSync(path.join(backupPathToMigrate, 'backup.txt'), 'Some Data');
		service.registerFolderBackupSync(toFolderBackupInfo(URI.file(backupPathToMigrate)));

		const workspaceBackupPath = service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(barFile.fsPath), backupPathToMigrate);

		assert.ok(fs.existsSync(workspaceBackupPath));
		assert.ok(fs.existsSync(path.join(workspaceBackupPath, 'backup.txt')));
		assert.ok(!fs.existsSync(backupPathToMigrate));

		const emptyBackups = service.getEmptyWindowBackupPaths();
		assert.strictEqual(0, emptyBackups.length);
	});

	test('service backup migration makes sure to preserve existing backups', () => {
		const backupPathToMigrate = service.toBackupPath(fooFile);
		fs.mkdirSync(backupPathToMigrate);
		fs.writeFileSync(path.join(backupPathToMigrate, 'backup.txt'), 'Some Data');
		service.registerFolderBackupSync(toFolderBackupInfo(URI.file(backupPathToMigrate)));

		const backupPathToPreserve = service.toBackupPath(barFile);
		fs.mkdirSync(backupPathToPreserve);
		fs.writeFileSync(path.join(backupPathToPreserve, 'backup.txt'), 'Some Data');
		service.registerFolderBackupSync(toFolderBackupInfo(URI.file(backupPathToPreserve)));

		const workspaceBackupPath = service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(barFile.fsPath), backupPathToMigrate);

		assert.ok(fs.existsSync(workspaceBackupPath));
		assert.ok(fs.existsSync(path.join(workspaceBackupPath, 'backup.txt')));
		assert.ok(!fs.existsSync(backupPathToMigrate));

		const emptyBackups = service.getEmptyWindowBackupPaths();
		assert.strictEqual(1, emptyBackups.length);
		assert.strictEqual(1, fs.readdirSync(path.join(backupHome, emptyBackups[0].backupFolder!)).length);
	});

	suite('loadSync', () => {
		test('getFolderBackupPaths() should return [] when workspaces.json doesn\'t exist', () => {
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when workspaces.json is not properly formed JSON (1)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when workspaces.json is not properly formed JSON (2)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{]');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when workspaces.json is not properly formed JSON (3)', async () => {
			fs.writeFileSync(backupWorkspacesPath, 'foo');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when folderWorkspaceInfos in workspaces.json is absent', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{}');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when folderWorkspaceInfos in workspaces.json is not a string array (1)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"folderWorkspaceInfos":{}}');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when folderWorkspaceInfos in workspaces.json is not a string array (2)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"folderWorkspaceInfos":{"foo": ["bar"]}}');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when folderWorkspaceInfos in workspaces.json is not a string array (3)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"folderWorkspaceInfos":{"foo": []}}');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when folderWorkspaceInfos in workspaces.json is not a string array (4)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"folderWorkspaceInfos":{"foo": "bar"}}');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when folderWorkspaceInfos in workspaces.json is not a string array (5)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"folderWorkspaceInfos":"foo"}');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should return [] when folderWorkspaceInfos in workspaces.json is not a string array (6)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"folderWorkspaceInfos":1}');
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getFolderBackupPaths() should migrate folderURIWorkspaces', async () => {
			await ensureFolderExists(existingTestFolder1);

			fs.writeFileSync(backupWorkspacesPath, JSON.stringify({ folderURIWorkspaces: [existingTestFolder1.toString()] }));
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), [toFolderBackupInfo(existingTestFolder1)]);
		});

		test('getFolderBackupPaths() should return [] when files.hotExit = "onExitAndWindowClose"', async () => {
			const fi = toFolderBackupInfo(URI.file(fooFile.fsPath.toUpperCase()));
			service.registerFolderBackupSync(fi);
			assertEqualFolderInfos(service.getFolderBackupPaths(), [fi]);
			configService.setUserConfiguration('files.hotExit', HotExitConfiguration.ON_EXIT_AND_WINDOW_CLOSE);
			await service.initialize();
			assertEqualFolderInfos(service.getFolderBackupPaths(), []);
		});

		test('getWorkspaceBackups() should return [] when workspaces.json doesn\'t exist', () => {
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when workspaces.json is not properly formed JSON (1)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when workspaces.json is not properly formed JSON (2)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{]');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when workspaces.json is not properly formed JSON (3)', async () => {
			fs.writeFileSync(backupWorkspacesPath, 'foo');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when folderWorkspaces in workspaces.json is absent', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootWorkspaces in workspaces.json is not a object array (1)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootWorkspaces":{}}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootWorkspaces in workspaces.json is not a object array (2)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootWorkspaces":{"foo": ["bar"]}}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootWorkspaces in workspaces.json is not a object array (3)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootWorkspaces":{"foo": []}}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootWorkspaces in workspaces.json is not a object array (4)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootWorkspaces":{"foo": "bar"}}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootWorkspaces in workspaces.json is not a object array (5)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootWorkspaces":"foo"}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootWorkspaces in workspaces.json is not a object array (6)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootWorkspaces":1}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootURIWorkspaces in workspaces.json is not a object array (1)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootURIWorkspaces":{}}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootURIWorkspaces in workspaces.json is not a object array (2)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootURIWorkspaces":{"foo": ["bar"]}}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootURIWorkspaces in workspaces.json is not a object array (3)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootURIWorkspaces":{"foo": []}}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootURIWorkspaces in workspaces.json is not a object array (4)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootURIWorkspaces":{"foo": "bar"}}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootURIWorkspaces in workspaces.json is not a object array (5)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootURIWorkspaces":"foo"}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when rootURIWorkspaces in workspaces.json is not a object array (6)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{"rootURIWorkspaces":1}');
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getWorkspaceBackups() should return [] when files.hotExit = "onExitAndWindowClose"', async () => {
			const upperFooPath = fooFile.fsPath.toUpperCase();
			service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(upperFooPath));
			assert.strictEqual(service.getWorkspaceBackups().length, 1);
			assert.deepStrictEqual(service.getWorkspaceBackups().map(r => r.workspace.configPath.toString()), [URI.file(upperFooPath).toString()]);
			configService.setUserConfiguration('files.hotExit', HotExitConfiguration.ON_EXIT_AND_WINDOW_CLOSE);
			await service.initialize();
			assert.deepStrictEqual(service.getWorkspaceBackups(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when workspaces.json doesn\'t exist', () => {
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when workspaces.json is not properly formed JSON (1)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when workspaces.json is not properly formed JSON (2)', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{]');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when workspaces.json is not properly formed JSON (3)', async () => {
			fs.writeFileSync(backupWorkspacesPath, 'foo');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when folderWorkspaces in workspaces.json is absent', async () => {
			fs.writeFileSync(backupWorkspacesPath, '{}');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when folderWorkspaces in workspaces.json is not a string array (1)', async function () {
			fs.writeFileSync(backupWorkspacesPath, '{"emptyWorkspaces":{}}');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when folderWorkspaces in workspaces.json is not a string array (2)', async function () {
			fs.writeFileSync(backupWorkspacesPath, '{"emptyWorkspaces":{"foo": ["bar"]}}');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when folderWorkspaces in workspaces.json is not a string array (3)', async function () {
			fs.writeFileSync(backupWorkspacesPath, '{"emptyWorkspaces":{"foo": []}}');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when folderWorkspaces in workspaces.json is not a string array (4)', async function () {
			fs.writeFileSync(backupWorkspacesPath, '{"emptyWorkspaces":{"foo": "bar"}}');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when folderWorkspaces in workspaces.json is not a string array (5)', async function () {
			fs.writeFileSync(backupWorkspacesPath, '{"emptyWorkspaces":"foo"}');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});

		test('getEmptyWorkspaceBackupPaths() should return [] when folderWorkspaces in workspaces.json is not a string array (6)', async function () {
			fs.writeFileSync(backupWorkspacesPath, '{"emptyWorkspaces":1}');
			await service.initialize();
			assert.deepStrictEqual(service.getEmptyWindowBackupPaths(), []);
		});
	});

	suite('dedupeFolderWorkspaces', () => {
		test('should ignore duplicates (folder workspace)', async () => {

			await ensureFolderExists(existingTestFolder1);

			const workspacesJson: IBackupWorkspacesFormat = {
				rootURIWorkspaces: [],
				folderWorkspaceInfos: [{ folderUri: existingTestFolder1.toString() }, { folderUri: existingTestFolder1.toString() }],
				emptyWorkspaceInfos: []
			};
			await pfs.Promises.writeFile(backupWorkspacesPath, JSON.stringify(workspacesJson));
			await service.initialize();

			const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json = <IBackupWorkspacesFormat>JSON.parse(buffer);
			assert.deepStrictEqual(json.folderWorkspaceInfos, [{ folderUri: existingTestFolder1.toString() }]);
		});

		test('should ignore duplicates on Windows and Mac (folder workspace)', async () => {

			await ensureFolderExists(existingTestFolder1);

			const workspacesJson: IBackupWorkspacesFormat = {
				rootURIWorkspaces: [],
				folderWorkspaceInfos: [{ folderUri: existingTestFolder1.toString() }, { folderUri: existingTestFolder1.toString().toLowerCase() }],
				emptyWorkspaceInfos: []
			};
			await pfs.Promises.writeFile(backupWorkspacesPath, JSON.stringify(workspacesJson));
			await service.initialize();
			const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json = <IBackupWorkspacesFormat>JSON.parse(buffer);
			assert.deepStrictEqual(json.folderWorkspaceInfos, [{ folderUri: existingTestFolder1.toString() }]);
		});

		test('should ignore duplicates on Windows and Mac (root workspace)', async () => {
			const workspacePath = path.join(testDir, 'Foo.code-workspace');
			const workspacePath1 = path.join(testDir, 'FOO.code-workspace');
			const workspacePath2 = path.join(testDir, 'foo.code-workspace');

			const workspace1 = await ensureWorkspaceExists(toWorkspace(workspacePath));
			const workspace2 = await ensureWorkspaceExists(toWorkspace(workspacePath1));
			const workspace3 = await ensureWorkspaceExists(toWorkspace(workspacePath2));

			const workspacesJson: IBackupWorkspacesFormat = {
				rootURIWorkspaces: [workspace1, workspace2, workspace3].map(toSerializedWorkspace),
				folderWorkspaceInfos: [],
				emptyWorkspaceInfos: []
			};
			await pfs.Promises.writeFile(backupWorkspacesPath, JSON.stringify(workspacesJson));
			await service.initialize();

			const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json = <IBackupWorkspacesFormat>JSON.parse(buffer);
			assert.strictEqual(json.rootURIWorkspaces.length, platform.isLinux ? 3 : 1);
			if (platform.isLinux) {
				assert.deepStrictEqual(json.rootURIWorkspaces.map(r => r.configURIPath), [URI.file(workspacePath).toString(), URI.file(workspacePath1).toString(), URI.file(workspacePath2).toString()]);
			} else {
				assert.deepStrictEqual(json.rootURIWorkspaces.map(r => r.configURIPath), [URI.file(workspacePath).toString()], 'should return the first duplicated entry');
			}
		});
	});

	suite('registerWindowForBackups', () => {
		test('should persist paths to workspaces.json (folder workspace)', async () => {
			service.registerFolderBackupSync(toFolderBackupInfo(fooFile));
			service.registerFolderBackupSync(toFolderBackupInfo(barFile));
			assertEqualFolderInfos(service.getFolderBackupPaths(), [toFolderBackupInfo(fooFile), toFolderBackupInfo(barFile)]);
			const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json = <IBackupWorkspacesFormat>JSON.parse(buffer);
			assert.deepStrictEqual(json.folderWorkspaceInfos, [{ folderUri: fooFile.toString() }, { folderUri: barFile.toString() }]);
		});

		test('should persist paths to workspaces.json (root workspace)', async () => {
			const ws1 = toWorkspaceBackupInfo(fooFile.fsPath);
			service.registerWorkspaceBackupSync(ws1);
			const ws2 = toWorkspaceBackupInfo(barFile.fsPath);
			service.registerWorkspaceBackupSync(ws2);

			assert.deepStrictEqual(service.getWorkspaceBackups().map(b => b.workspace.configPath.toString()), [fooFile.toString(), barFile.toString()]);
			assert.strictEqual(ws1.workspace.id, service.getWorkspaceBackups()[0].workspace.id);
			assert.strictEqual(ws2.workspace.id, service.getWorkspaceBackups()[1].workspace.id);

			const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json = <IBackupWorkspacesFormat>JSON.parse(buffer);

			assert.deepStrictEqual(json.rootURIWorkspaces.map(b => b.configURIPath), [fooFile.toString(), barFile.toString()]);
			assert.strictEqual(ws1.workspace.id, json.rootURIWorkspaces[0].id);
			assert.strictEqual(ws2.workspace.id, json.rootURIWorkspaces[1].id);
		});
	});

	test('should always store the workspace path in workspaces.json using the case given, regardless of whether the file system is case-sensitive (folder workspace)', async () => {
		service.registerFolderBackupSync(toFolderBackupInfo(URI.file(fooFile.fsPath.toUpperCase())));
		assertEqualFolderInfos(service.getFolderBackupPaths(), [toFolderBackupInfo(URI.file(fooFile.fsPath.toUpperCase()))]);

		const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
		const json = <IBackupWorkspacesFormat>JSON.parse(buffer);
		assert.deepStrictEqual(json.folderWorkspaceInfos, [{ folderUri: URI.file(fooFile.fsPath.toUpperCase()).toString() }]);
	});

	test('should always store the workspace path in workspaces.json using the case given, regardless of whether the file system is case-sensitive (root workspace)', async () => {
		const upperFooPath = fooFile.fsPath.toUpperCase();
		service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(upperFooPath));
		assert.deepStrictEqual(service.getWorkspaceBackups().map(b => b.workspace.configPath.toString()), [URI.file(upperFooPath).toString()]);

		const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
		const json = (<IBackupWorkspacesFormat>JSON.parse(buffer));
		assert.deepStrictEqual(json.rootURIWorkspaces.map(b => b.configURIPath), [URI.file(upperFooPath).toString()]);
	});

	suite('removeBackupPathSync', () => {
		test('should remove folder workspaces from workspaces.json (folder workspace)', async () => {
			service.registerFolderBackupSync(toFolderBackupInfo(fooFile));
			service.registerFolderBackupSync(toFolderBackupInfo(barFile));
			service.unregisterFolderBackupSync(fooFile);

			const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json = (<IBackupWorkspacesFormat>JSON.parse(buffer));
			assert.deepStrictEqual(json.folderWorkspaceInfos, [{ folderUri: barFile.toString() }]);
			service.unregisterFolderBackupSync(barFile);

			const content = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json2 = (<IBackupWorkspacesFormat>JSON.parse(content));
			assert.deepStrictEqual(json2.folderWorkspaceInfos, []);
		});

		test('should remove folder workspaces from workspaces.json (root workspace)', async () => {
			const ws1 = toWorkspaceBackupInfo(fooFile.fsPath);
			service.registerWorkspaceBackupSync(ws1);
			const ws2 = toWorkspaceBackupInfo(barFile.fsPath);
			service.registerWorkspaceBackupSync(ws2);
			service.unregisterWorkspaceBackupSync(ws1.workspace);

			const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json = (<IBackupWorkspacesFormat>JSON.parse(buffer));
			assert.deepStrictEqual(json.rootURIWorkspaces.map(r => r.configURIPath), [barFile.toString()]);
			service.unregisterWorkspaceBackupSync(ws2.workspace);

			const content = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json2 = (<IBackupWorkspacesFormat>JSON.parse(content));
			assert.deepStrictEqual(json2.rootURIWorkspaces, []);
		});

		test('should remove empty workspaces from workspaces.json', async () => {
			service.registerEmptyWindowBackupSync('foo');
			service.registerEmptyWindowBackupSync('bar');
			service.unregisterEmptyWindowBackupSync('foo');

			const buffer = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json = (<IBackupWorkspacesFormat>JSON.parse(buffer));
			assert.deepStrictEqual(json.emptyWorkspaceInfos, [{ backupFolder: 'bar' }]);
			service.unregisterEmptyWindowBackupSync('bar');

			const content = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json2 = (<IBackupWorkspacesFormat>JSON.parse(content));
			assert.deepStrictEqual(json2.emptyWorkspaceInfos, []);
		});

		test('should fail gracefully when removing a path that doesn\'t exist', async () => {

			await ensureFolderExists(existingTestFolder1); // make sure backup folder exists, so the folder is not removed on loadSync

			const workspacesJson: IBackupWorkspacesFormat = { rootURIWorkspaces: [], folderWorkspaceInfos: [{ folderUri: existingTestFolder1.toString() }], emptyWorkspaceInfos: [] };
			await pfs.Promises.writeFile(backupWorkspacesPath, JSON.stringify(workspacesJson));
			await service.initialize();
			service.unregisterFolderBackupSync(barFile);
			service.unregisterEmptyWindowBackupSync('test');
			const content = await pfs.Promises.readFile(backupWorkspacesPath, 'utf-8');
			const json = (<IBackupWorkspacesFormat>JSON.parse(content));
			assert.deepStrictEqual(json.folderWorkspaceInfos, [{ folderUri: existingTestFolder1.toString() }]);
		});
	});

	suite('getWorkspaceHash', () => {
		(platform.isLinux ? test.skip : test)('should ignore case on Windows and Mac', () => {
			const assertFolderHash = (uri1: URI, uri2: URI) => {
				assert.strictEqual(service.getFolderHash(toFolderBackupInfo(uri1)), service.getFolderHash(toFolderBackupInfo(uri2)));
			};

			if (platform.isMacintosh) {
				assertFolderHash(URI.file('/foo'), URI.file('/FOO'));
			}

			if (platform.isWindows) {
				assertFolderHash(URI.file('c:\\foo'), URI.file('C:\\FOO'));
			}
		});
	});

	suite('mixed path casing', () => {
		test('should handle case insensitive paths properly (registerWindowForBackupsSync) (folder workspace)', () => {
			service.registerFolderBackupSync(toFolderBackupInfo(fooFile));
			service.registerFolderBackupSync(toFolderBackupInfo(URI.file(fooFile.fsPath.toUpperCase())));

			if (platform.isLinux) {
				assert.strictEqual(service.getFolderBackupPaths().length, 2);
			} else {
				assert.strictEqual(service.getFolderBackupPaths().length, 1);
			}
		});

		test('should handle case insensitive paths properly (registerWindowForBackupsSync) (root workspace)', () => {
			service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(fooFile.fsPath));
			service.registerWorkspaceBackupSync(toWorkspaceBackupInfo(fooFile.fsPath.toUpperCase()));

			if (platform.isLinux) {
				assert.strictEqual(service.getWorkspaceBackups().length, 2);
			} else {
				assert.strictEqual(service.getWorkspaceBackups().length, 1);
			}
		});

		test('should handle case insensitive paths properly (removeBackupPathSync) (folder workspace)', () => {

			// same case
			service.registerFolderBackupSync(toFolderBackupInfo(fooFile));
			service.unregisterFolderBackupSync(fooFile);
			assert.strictEqual(service.getFolderBackupPaths().length, 0);

			// mixed case
			service.registerFolderBackupSync(toFolderBackupInfo(fooFile));
			service.unregisterFolderBackupSync(URI.file(fooFile.fsPath.toUpperCase()));

			if (platform.isLinux) {
				assert.strictEqual(service.getFolderBackupPaths().length, 1);
			} else {
				assert.strictEqual(service.getFolderBackupPaths().length, 0);
			}
		});
	});

	suite('getDirtyWorkspaces', () => {
		test('should report if a workspace or folder has backups', async () => {
			const folderBackupPath = service.registerFolderBackupSync(toFolderBackupInfo(fooFile));

			const backupWorkspaceInfo = toWorkspaceBackupInfo(fooFile.fsPath);
			const workspaceBackupPath = service.registerWorkspaceBackupSync(backupWorkspaceInfo);

			assert.strictEqual(((await service.getDirtyWorkspaces()).length), 0);

			try {
				await pfs.Promises.mkdir(path.join(folderBackupPath, Schemas.file), { recursive: true });
				await pfs.Promises.mkdir(path.join(workspaceBackupPath, Schemas.untitled), { recursive: true });
			} catch (error) {
				// ignore - folder might exist already
			}

			assert.strictEqual(((await service.getDirtyWorkspaces()).length), 0);

			fs.writeFileSync(path.join(folderBackupPath, Schemas.file, '594a4a9d82a277a899d4713a5b08f504'), '');
			fs.writeFileSync(path.join(workspaceBackupPath, Schemas.untitled, '594a4a9d82a277a899d4713a5b08f504'), '');

			const dirtyWorkspaces = await service.getDirtyWorkspaces();
			assert.strictEqual(dirtyWorkspaces.length, 2);

			let found = 0;
			for (const dirtyWorkpspace of dirtyWorkspaces) {
				if (isFolderBackupInfo(dirtyWorkpspace)) {
					if (isEqual(fooFile, dirtyWorkpspace.folderUri)) {
						found++;
					}
				} else {
					if (isEqual(backupWorkspaceInfo.workspace.configPath, dirtyWorkpspace.workspace.configPath)) {
						found++;
					}
				}
			}

			assert.strictEqual(found, 2);
		});
	});
});
