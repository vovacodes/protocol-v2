#!/usr/bin/env node
import { Command, OptionValues, program } from 'commander';
import os from 'os';
import fs from 'fs';
import log from 'loglevel';
import { Admin, ClearingHouseUser, initialize } from '@moet/sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import BN from 'bn.js';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

log.setLevel(log.levels.INFO);

function commandWithDefaultOption(commandName: string): Command {
	return program
		.command(commandName)
		.option('-e, --env <env>', 'environment e.g devnet, mainnet-beta')
		.option('-k, --keypair <path>', 'Solana wallet')
		.option('-u, --url <url>', 'rpc url e.g. https://api.devnet.solana.com');
}

export function loadKeypair(keypairPath: string): Keypair {
	if (!keypairPath || keypairPath == '') {
		throw new Error('Keypair is required!');
	}
	const loaded = Keypair.fromSecretKey(
		new Uint8Array(JSON.parse(fs.readFileSync(keypairPath).toString()))
	);
	log.info(`wallet public key: ${loaded.publicKey}`);
	return loaded;
}

function adminFromOptions(options: OptionValues): Admin {
	let { env, keypair, url } = options;
	const config = getConfig();
	if (!env) {
		env = config.env;
	}
	log.info(`env: ${env}`);
	const sdkConfig = initialize({ env: env });

	if (!url) {
		url = config.url;
	}
	log.info(`url: ${url}`);
	const connection = new Connection(url);

	if (!keypair) {
		keypair = config.keypair;
	}
	const wallet = new Wallet(loadKeypair(keypair));

	return Admin.from(
		connection,
		wallet,
		new PublicKey(sdkConfig.CLEARING_HOUSE_PROGRAM_ID)
	);
}

async function wrapActionInAdminSubscribeUnsubscribe(
	options: OptionValues,
	action: (admin: Admin) => Promise<void>
): Promise<void> {
	const admin = adminFromOptions(options);
	log.info(`ClearingHouse subscribing`);
	await admin.subscribe();
	log.info(`ClearingHouse subscribed`);

	try {
		await action(admin);
	} catch (e) {
		log.error(e);
	}

	log.info(`ClearingHouse unsubscribing`);
	await admin.unsubscribe();
	log.info(`ClearingHouse unsubscribed`);
}

async function wrapActionInUserSubscribeUnsubscribe(
	options: OptionValues,
	action: (user: ClearingHouseUser) => Promise<void>
): Promise<void> {
	const admin = adminFromOptions(options);
	log.info(`ClearingHouse subscribing`);
	await admin.subscribe();
	log.info(`ClearingHouse subscribed`);
	const clearingHouseUser = ClearingHouseUser.from(
		admin,
		admin.wallet.publicKey
	);
	log.info(`User subscribing`);
	await clearingHouseUser.subscribe();
	log.info(`User subscribed`);

	try {
		await action(clearingHouseUser);
	} catch (e) {
		log.error(e);
	}

	log.info(`User unsubscribing`);
	await clearingHouseUser.unsubscribe();
	log.info(`User unsubscribed`);

	log.info(`ClearingHouse unsubscribing`);
	await admin.unsubscribe();
	log.info(`ClearingHouse unsubscribed`);
}

commandWithDefaultOption('initialize')
	.argument('<collateral mint>', 'The collateral mint')
	.argument(
		'<admin controls prices>',
		'Whether the admin should control prices'
	)
	.action(
		async (collateralMint, adminControlsPrices, options: OptionValues) => {
			await wrapActionInAdminSubscribeUnsubscribe(
				options,
				async (admin: Admin) => {
					log.info(`collateralMint: ${collateralMint}`);
					log.info(`adminControlsPrices: ${adminControlsPrices}`);
					const collateralMintPublicKey = new PublicKey(collateralMint);
					log.info(`ClearingHouse initializing`);
					await admin.initialize(collateralMintPublicKey, adminControlsPrices);
				}
			);
		}
	);

commandWithDefaultOption('update-k')
	.argument('<market>', 'The market to adjust k for')
	.argument('<numerator>', 'Numerator to multiply k by')
	.argument('<denominator>', 'Denominator to divide k by')
	.action(async (market, numerator, denominator, options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				log.info(`market: ${market}`);
				log.info(`numerator: ${numerator}`);
				log.info(`denominator: ${denominator}`);
				market = new BN(market);
				numerator = new BN(numerator);
				denominator = new BN(denominator);

				const amm = admin.getMarketsAccount().markets[market.toNumber()].amm;
				const oldSqrtK = amm.sqrtK;
				log.info(`Current sqrt k: ${oldSqrtK.toString()}`);

				const newSqrtK = oldSqrtK.mul(numerator).div(denominator);
				log.info(`New sqrt k: ${newSqrtK.toString()}`);

				log.info(`Updating K`);
				await admin.updateK(newSqrtK, market);
				log.info(`Updated K`);
			}
		);
	});

commandWithDefaultOption('repeg')
	.argument('<market>', 'The market to adjust k for')
	.argument('<peg>', 'New Peg')
	.action(async (market, peg, options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				log.info(`market: ${market}`);
				log.info(`peg: ${peg}`);
				market = new BN(market);
				peg = new BN(peg);

				const amm = admin.getMarketsAccount().markets[market.toNumber()].amm;
				const oldPeg = amm.pegMultiplier;
				log.info(`Current peg: ${oldPeg.toString()}`);

				log.info(`Updating peg`);
				await admin.repegAmmCurve(peg, market);
				log.info(`Updated peg`);
			}
		);
	});

commandWithDefaultOption('deposit')
	.argument('<amount>', 'The amount to deposit')
	.action(async (amount, options: OptionValues) => {
		await wrapActionInUserSubscribeUnsubscribe(
			options,
			async (user: ClearingHouseUser) => {
				log.info(`amount: ${amount}`);
				amount = new BN(amount);

				const associatedTokenPublicKey = await Token.getAssociatedTokenAddress(
					ASSOCIATED_TOKEN_PROGRAM_ID,
					TOKEN_PROGRAM_ID,
					user.clearingHouse.getStateAccount().collateralMint,
					user.authority
				);

				await user.clearingHouse.depositCollateral(
					amount,
					associatedTokenPublicKey
				);
			}
		);
	});

function getConfigFileDir(): string {
	return os.homedir() + `/.config/drift-v1`;
}

function getConfigFilePath(): string {
	return `${getConfigFileDir()}/config.json`;
}

function getConfig() {
	if (!fs.existsSync(getConfigFilePath())) {
		console.error('drfit-v1 config does not exit. Run `drift-v1 config init`');
		return;
	}

	return JSON.parse(fs.readFileSync(getConfigFilePath(), 'utf8'));
}

const config = program.command('config');
config.command('init').action(async () => {
	const defaultConfig = {
		env: 'devnet',
		url: 'https://api.devnet.solana.com',
		keypair: `${os.homedir()}/.config/solana/id.json`,
	};

	const dir = getConfigFileDir();
	if (!fs.existsSync(getConfigFileDir())) {
		fs.mkdirSync(dir, { recursive: true });
	}

	fs.writeFileSync(getConfigFilePath(), JSON.stringify(defaultConfig));
});

config
	.command('set')
	.argument('<key>', 'the config key e.g. env, url, keypair')
	.argument('<value>')
	.action(async (key, value) => {
		if (key !== 'env' && key !== 'url' && key !== 'keypair') {
			console.error(`Key must be env, url or keypair`);
			return;
		}

		const config = JSON.parse(fs.readFileSync(getConfigFilePath(), 'utf8'));
		config[key] = value;
		fs.writeFileSync(getConfigFilePath(), JSON.stringify(config));
	});

config.command('get').action(async () => {
	const config = getConfig();
	console.log(JSON.stringify(config, null, 4));
});

program.parse(process.argv);