/**
 * §16 — import endpoints. All gated on masters.manage, the same permission the
 * Setup Wizard's write endpoints use. Upload is multipart with a hard size cap;
 * commit re-parses the file rather than trusting anything the client kept.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import type { AuthedRequest } from "../masters/crud.util";
import { ImportService } from "./import.service";
import { FreezeService } from "../freeze/freeze.service";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_BYTES = 10 * 1024 * 1024;

/** Multer's type lives behind @types/multer; keep the surface minimal. */
interface UploadedXlsx {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function assertXlsx(file: UploadedXlsx | undefined): UploadedXlsx {
  if (!file) throw new BadRequestException("No file was uploaded. Choose an .xlsx file and try again.");
  if (!/\.xlsx$/i.test(file.originalname)) {
    throw new BadRequestException(
      `"${file.originalname}" is not an .xlsx file. Open it in Excel and use File → Save As → Excel Workbook (.xlsx). Older .xls and .csv files are not supported.`,
    );
  }
  if (file.size > MAX_BYTES) {
    throw new BadRequestException(`That file is ${(file.size / 1048576).toFixed(1)} MB — the limit is 10 MB.`);
  }
  return file;
}

const sendXlsx = (res: Response, buf: Buffer, filename: string) => {
  res.setHeader("Content-Type", XLSX_MIME);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", String(buf.length));
  res.end(buf);
};

const stamp = () => new Date().toISOString().slice(0, 10);

@Controller("import")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class ImportController {
  constructor(
    private readonly importer: ImportService,
    private readonly freeze: FreezeService,
  ) {}

  /** Blank template with samples, dropdowns, and the school's names to copy. */
  @Get("template")
  async template(@Req() req: AuthedRequest, @Res() res: Response) {
    const buf = await this.importer.template(req.user.schoolId);
    sendXlsx(res, buf, `edutimetable-master-template-${stamp()}.xlsx`);
  }

  /** The same workbook filled with current masters — backup and bulk-edit. */
  @Get("export")
  async exportCurrent(@Req() req: AuthedRequest, @Res() res: Response) {
    const buf = await this.importer.exportCurrent(req.user.schoolId);
    sendXlsx(res, buf, `edutimetable-masters-${stamp()}.xlsx`);
  }

  /** Validate only — never writes. Always run before commit. */
  @Post("dry-run")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BYTES } }))
  async dryRun(@Req() req: AuthedRequest, @UploadedFile() file: UploadedXlsx) {
    const f = assertXlsx(file);
    const { plan, unknownSheets, truncated, readinessPreview } = await this.importer.dryRun(
      req.user.schoolId,
      f.buffer,
    );
    return { plan, unknownSheets, truncated, readinessPreview, fileName: f.originalname };
  }

  /** All-or-nothing write. Re-validates from the uploaded bytes. */
  @Post("commit")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BYTES } }))
  async commit(@Req() req: AuthedRequest, @UploadedFile() file: UploadedXlsx) {
    /*
      §29.1 — the blunt check, and deliberately so.

      A workbook resolves names to rows deep inside one transaction, so it
      cannot say up front which timetables it will touch. The narrow version
      would have to re-derive the importer's own name resolution, and a second
      copy of that is exactly how the two would drift. `dry-run` is untouched:
      seeing what a file would do is not a change.
    */
    await this.freeze.assertNoneFrozen("master data");
    const f = assertXlsx(file);
    return this.importer.commit(req.user.schoolId, f.buffer);
  }

  /** The uploaded file back, with every problem marked in place. */
  @Post("annotate")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BYTES } }))
  async annotate(@Req() req: AuthedRequest, @UploadedFile() file: UploadedXlsx, @Res() res: Response) {
    const f = assertXlsx(file);
    const buf = await this.importer.annotate(f.buffer, req.user.schoolId);
    sendXlsx(res, buf, f.originalname.replace(/\.xlsx$/i, "") + `-errors-${stamp()}.xlsx`);
  }
}
