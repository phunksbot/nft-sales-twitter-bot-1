import { SlashCommandBuilder } from '@discordjs/builders';
import { HttpService } from '@nestjs/axios';
import { Injectable } from "@nestjs/common";
import { BaseService } from "src/base.service";
import { createLogger } from "src/logging.utils";
import Database from 'better-sqlite3'
import { REST } from '@discordjs/rest';
import { config } from '../../config';
import { Routes } from 'discord-api-types/v9'
import { ethers } from 'ethers';
import { BindRequestDto } from './models';
import { SignatureError } from './errors';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

const logger = createLogger('statistics.service')

@Injectable()
export class DAOService extends BaseService {
  
  provider = this.getWeb3Provider();
  db = new Database(`${process.env.WORK_DIRECTORY || './'}dao.db.db` /*, { verbose: logger.info } */);  
  insert: any;
  positionCheck: any;
  positionUpdate: any;
  currentBlock: number;

  constructor(
    protected readonly http: HttpService
  ) {
    super(http)
    logger.info('created DAOService')
    this.start()
    this.discordClient.init()
    this.registerCommands()
  }

  async start() {

    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id text NOT NULL,
        discord_username text NOT NULL,
        web3_public_key text NOT NULL UNIQUE
      );`,
    ).run();
  }

  async bounded(username:string) {

  }

  async bindAccount(request: BindRequestDto) {

    // TODO check discord account
    const { data } = await firstValueFrom(this.http.get('https://discord.com/api/users/@me', {
      headers: {
        authorization: `Bearer ${request.discordAccessToken}`,
      }
    }).pipe(
      catchError((error: AxiosError) => {
        logger.error(error)
        throw 'An error happened!';
      }),
    ))
    if (data.id != request.discordUserId) {
      throw new SignatureError('invalid discord user id')
    }
    const signerAddr = await ethers.verifyMessage('This signature is safe and will bind your wallet to your discord user ID.', request.signature);
    if (signerAddr.toLowerCase() !== request.account.toLowerCase()) {
      throw new SignatureError('invalid signature')
    }

    console.log('request', request)

    const stmt = this.db.prepare(`
      INSERT INTO accounts (discord_user_id, discord_username, web3_public_key)
      VALUES (@discordUserId, @discordUsername, @account)
      ON CONFLICT(web3_public_key) DO UPDATE SET discord_user_id = excluded.discord_user_id, discord_username = excluded.discord_username
    `)
    stmt.run(request)
  }

  async registerCommands() {
    
    const bind = new SlashCommandBuilder()
      .setName('bind')
      .setDescription('Bind your web3 wallet to your discord account')
    
    const bounded = new SlashCommandBuilder()
      .setName('bounded')
      .setDescription('Show the currently web3 wallet bounded to your discord account')
        
    const commands = [
      bind.toJSON(),
      bounded.toJSON()
    ]
    this.getDiscordCommands().push(...commands)

    this.discordClient.getClient().on('interactionCreate', async (interaction) => {
      try {
        if (!interaction.isCommand()) return;
        if ('bind' === interaction.commandName) {
          await interaction.deferReply()
          interaction.editReply(`Click here to bind your wallet: http://${config.daoModuleListenAddress}/`)
        } else if ('bounded' === interaction.commandName) {
          await interaction.deferReply()
          const users = this.getUsersByDiscordUserId(interaction.user.id.toString())
          if (users.length) {
            let response = `Currently bound web3 wallet(s): \n`
            response += '```'
            for (const u of users) response += `${u.web3_public_key} \n`
            response += '```\n'
            interaction.editReply(response)
          }
          else 
            interaction.editReply(`No wallet bounded yet.`)
        }
      } catch (err) {
        logger.info(err)
      }
    });      
  }
  getUsersByDiscordUserId(id: string) {
    const rows = this.db.prepare(`
      SELECT * FROM accounts WHERE discord_user_id = @id
    `).all({id})
    return rows
  }
  getUserByWeb3Wallet(wallet: string) {
    const row = this.db.prepare(`
      SELECT * FROM accounts WHERE lower(web3_public_key) = lower(@wallet)
    `).get({wallet})
    return row
  }

}