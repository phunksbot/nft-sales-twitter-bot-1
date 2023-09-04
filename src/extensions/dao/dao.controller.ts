import { Body, Controller, Get, Post } from '@nestjs/common';
import { BindRequestDto } from './models';
import { DAOService } from './dao.extension.service';
import { SignatureError } from './errors';

@Controller('dao')
export class DAOController {

  constructor(private daoService:DAOService) {

  }
  
  @Get('status')
  status(): string {
    return 'ok';
  }
  @Post('bind')
  bind(@Body() request: BindRequestDto): any {
    console.log(request)
    try {
      this.daoService.bindAccount(request)
    } catch (error) {
      console.log('error', error)
      return {result: 'ko'};
    }
    return {result: 'ok'};
  }
}
