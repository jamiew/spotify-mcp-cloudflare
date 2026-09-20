import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const tokenSchema = z.object({
	version: z.literal(1),
	clientId: z.string().min(1),
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	expiresAt: z.number().int().positive(),
	scope: z.string(),
});

export type LocalTokens = z.infer<typeof tokenSchema>;

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

export function stateDirectory(): string {
	const directory =
		process.env.SPOTIFY_MCP_STATE_DIR ?? join(homedir(), ".local", "state", "spotify-mcp");
	if (!isAbsolute(directory)) throw new Error("SPOTIFY_MCP_STATE_DIR must be an absolute path.");
	return directory;
}

/** One process owns this grant for its entire lifetime, including login/signout. */
export class LocalTokenStore {
	private closed = false;
	private readonly tokenPath: string;
	private readonly lockPath: string;

	private constructor(private readonly directory: string) {
		this.tokenPath = join(directory, "tokens.json");
		this.lockPath = join(directory, "owner.lock");
	}

	static async acquire(directory: string): Promise<LocalTokenStore> {
		if (process.platform === "win32") {
			throw new Error(
				"The private local token store currently requires macOS or Linux file permissions.",
			);
		}
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
			throw new Error(
				`Token directory must be owned by you, not a symlink, and private (chmod 700): ${directory}`,
			);
		}
		const store = new LocalTokenStore(directory);
		try {
			await mkdir(store.lockPath, { mode: 0o700 });
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
			// Never reclaim a lock on a timer: a suspended owner can still rotate a token.
			throw new Error(
				`Spotify local credentials are already in use. Stop the other server/login first. If it crashed, confirm no process is using this store before removing ${store.lockPath}.`,
			);
		}
		try {
			await writeFile(join(store.lockPath, "pid"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
		} catch (error) {
			await rmdir(store.lockPath);
			throw error;
		}
		return store;
	}

	private ensureOpen(): void {
		if (this.closed) throw new Error("The local token store is closed.");
	}

	async read(): Promise<LocalTokens | null> {
		this.ensureOpen();
		const file = await open(this.tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
			(error: unknown) => {
				if (hasCode(error, "ENOENT")) return null;
				throw error;
			},
		);
		if (!file) return null;
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
				throw new Error(
					"Local tokens must be a private, user-owned file (chmod 600). Run signout and login to replace it.",
				);
			}
			let value: unknown;
			try {
				value = JSON.parse(await file.readFile("utf8"));
			} catch {
				throw new Error("The local token file is invalid. Run login again.");
			}
			const result = tokenSchema.safeParse(value);
			if (!result.success) throw new Error("The local token file is invalid. Run login again.");
			return result.data;
		} finally {
			await file.close();
		}
	}

	async write(tokens: LocalTokens): Promise<void> {
		this.ensureOpen();
		const parsed = tokenSchema.safeParse(tokens);
		if (!parsed.success) throw new Error("Refusing to store an invalid Spotify token response.");
		const temporary = join(this.directory, `.tokens-${randomUUID()}.tmp`);
		try {
			const file = await open(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
				0o600,
			);
			try {
				await file.chmod(0o600);
				await file.writeFile(`${JSON.stringify(parsed.data)}\n`, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, this.tokenPath);
			// Persist the rename before returning a newly rotated access token to callers.
			const directory = await open(this.directory, constants.O_RDONLY);
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} finally {
			await unlink(temporary).catch((error: unknown) => {
				if (!hasCode(error, "ENOENT")) throw error;
			});
		}
	}

	async clear(): Promise<void> {
		this.ensureOpen();
		await unlink(this.tokenPath).catch((error: unknown) => {
			if (!hasCode(error, "ENOENT")) throw error;
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await unlink(join(this.lockPath, "pid"));
		await rmdir(this.lockPath);
	}
}
