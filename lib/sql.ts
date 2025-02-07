/**
 * Async worker thread wrapper around SQLite, written to improve concurrent performance.
 * @author mia-pi-git
 */
import {QueryProcessManager} from './process-manager';
import type * as sqlite from 'better-sqlite3';
import {FS} from './fs';

export const DB_NOT_FOUND = null;
export const STATEMENT_NOT_FOUND = false;

export interface SQLOptions {
	file: string;
	/** file to import database functions from - this should be relative to this filename. */
	extension?: string;
	/** options to be passed to better-sqlite3 */
	sqliteOptions?: sqlite.Options;
}

type DataType = unknown[] | Record<string, unknown>;

export interface TransactionEnvironment {
	db: sqlite.Database;
	statements: Map<string, sqlite.Statement>;
}

type DatabaseQuery = {
	/** Prepare a statement - data is the statement. */
	type: 'prepare', data: string,
} | {
	/** Get all lines from a statement. Data is the params, num is the statement number. */
	type: 'all', data: DataType, statement: string,
} | {
	/** Execute raw SQL in the database. */
	type: "exec", data: string,
} | {
	/** Get one line from a prepared statement. */
	type: 'get', data: DataType, statement: string,
} | {
	/** Run a prepared statement. */
	type: 'run', data: DataType, statement: string,
} | {
	type: 'transaction', name: string, data: DataType,
} | {
	type: 'start', options: SQLOptions,
};

type ErrorHandler = (error: Error, data: DatabaseQuery) => void;

function getModule() {
	try {
		return require('better-sqlite3') as typeof sqlite.default;
	} catch (e) {
		return null;
	}
}

export class Statement {
	private db: SQLDatabaseManager;
	private statement: string;
	constructor(statement: string, db: SQLDatabaseManager) {
		this.db = db;
		this.statement = statement;
	}
	run(data: DataType) {
		return this.db.run(this.statement, data);
	}
	all(data: DataType) {
		return this.db.all(this.statement, data);
	}
	get(data: DataType) {
		return this.db.get(this.statement, data);
	}
	toString() {
		return this.statement;
	}
}

export class SQLDatabaseManager extends QueryProcessManager<DatabaseQuery, any> {
	options: SQLOptions;
	database: null | sqlite.Database = null;
	state: {
		transactions: Map<string, sqlite.Transaction>,
		statements: Map<string, sqlite.Statement>,
	};
	private dbReady = false;
	onError: ErrorHandler;
	constructor(module: NodeJS.Module, options: SQLOptions, onError?: ErrorHandler) {
		super(module, query => {
			if (!this.dbReady) {
				this.setupDatabase();
			}
			try {
				switch (query.type) {
				case 'transaction': {
					const transaction = this.state.transactions.get(query.name);
					// !transaction covers db not existing, typically, but this is just to appease ts
					if (!transaction || !this.database) {
						return null;
					}
					const env: TransactionEnvironment = {
						db: this.database,
						statements: this.state.statements,
					};
					return transaction(query.data, env) || null;
				}
				case 'exec': {
					if (!this.database) return {changes: 0};
					this.database.exec(query.data);
					return true;
				}
				case 'get': {
					if (!this.database) {
						return null;
					}
					const statement = this.state.statements.get(query.statement);
					if (!statement) return STATEMENT_NOT_FOUND;
					return statement.get(query.data);
				}
				case 'run': {
					if (!this.database) {
						return null;
					}
					const statement = this.state.statements.get(query.statement);
					if (!statement) return STATEMENT_NOT_FOUND
					return statement.run(query.data);
				}
				case 'all': {
					if (!this.database) {
						return null;
					}
					const statement = this.state.statements.get(query.statement);
					if (!statement) return STATEMENT_NOT_FOUND;
					return statement.all(query.data);
				}
				case 'prepare':
					if (!this.database) {
						return null;
					}
					this.state.statements.set(query.data, this.database.prepare(query.data));
					return query.data;
				}
			} catch (error) {
				return this.onError(error, query);
			}
		});

		this.options = options;
		this.onError = onError || ((err, query) => {
			if (global.Monitor?.crashlog) {
				Monitor.crashlog(err, `an ${this.basename} SQLite process`, query);
				return null;
			}
			throw new Error(`SQLite error: ${err.message} (${JSON.stringify(query)})`);
		});
		this.state = {
			transactions: new Map(),
			statements: new Map(),
		};
		if (!this.isParentProcess) this.setupDatabase();
	}
	setupDatabase() {
		if (this.dbReady) return;
		this.dbReady = true;
		const {file, extension} = this.options;
		const Database = getModule();
		this.database = Database ? new Database(file) : null;
		if (extension && this.database) {
			const {
				functions,
				transactions: storedTransactions,
				statements: storedStatements,
				onDatabaseStart,
				// eslint-disable-next-line @typescript-eslint/no-var-requires
			} = require(`../${extension}`);
			if (functions) {
				for (const k in functions) {
					this.database.function(k, functions[k]);
				}
			}
			if (storedTransactions) {
				for (const t in storedTransactions) {
					const transaction = this.database.transaction(storedTransactions[t]);
					this.state.transactions.set(t, transaction);
				}
			}
			if (storedStatements) {
				for (const k in storedStatements) {
					const statement = this.database.prepare(storedStatements[k]);
					this.state.statements.set(statement.source, statement);
				}
			}
			if (onDatabaseStart) {
				onDatabaseStart(this.database);
			}
		}
	}
	all<T = any>(statement: string | Statement, data: DataType = []): Promise<T[]> {
		if (typeof statement !== 'string') statement = statement.toString();
		return this.query({type: 'all', statement, data});
	}
	get<T = any>(statement: string | Statement, data: DataType = []): Promise<T> {
		if (typeof statement !== 'string') statement = statement.toString();
		return this.query({type: 'get', statement, data});
	}
	run(statement: string | Statement, data: DataType = []): Promise<{changes: number}> {
		if (typeof statement !== 'string') statement = statement.toString();
		return this.query({type: 'run', statement, data});
	}
	transaction<T = any>(name: string, data: DataType = []): Promise<T> {
		return this.query({type: 'transaction', name, data});
	}
	async prepare(statement: string): Promise<Statement | null> {
		const source = await this.query({type: 'prepare', data: statement});
		if (!source) return null;
		return new Statement(source, this);
	}
	exec(data: string): Promise<{changes: number}> {
		return this.query({type: 'exec', data});
	}
	async runFile(file: string) {
		const contents = await FS(file).read();
		return this.query({type: 'exec', data: contents});
	}
	async query(data: DatabaseQuery) {
		const result = await super.query(data);
		if (result === STATEMENT_NOT_FOUND) {
			throw new Error("Prepare a statement before using another database function with SQLDatabase.prepare");
		}
		return result;
	}
}

interface SetupOptions {
	onError: ErrorHandler;
	processes: number;
}

export function SQL(
	module: NodeJS.Module, input: SQLOptions & Partial<SetupOptions>
) {
	const {onError, processes} = input;
	for (const k of ['onError', 'processes'] as const) delete input[k];
	const PM = new SQLDatabaseManager(module, input, onError);
	if (PM.isParentProcess) {
		if (processes) PM.spawn(processes);
	}
	return PM;
}

export namespace SQL {
	export type DatabaseManager = import('./sql').SQLDatabaseManager;
	export type Statement = import('./sql').Statement;
	export type Options = import('./sql').SQLOptions;
}
