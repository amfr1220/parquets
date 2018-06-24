import { WriteStream } from 'fs';
import { Stream, Transform } from 'stream';
import { PARQUET_CODEC } from './codec';
import * as Compression from './compression';
import { TODO, WriteStreamOptions } from './declare';
// tslint:disable-next-line:max-line-length
import { ColumnChunk, ColumnMetaData, CompressionCodec, ConvertedType, DataPageHeader, DataPageHeaderV2, Encoding, FieldRepetitionType, FileMetaData, KeyValue, PageHeader, PageType, RowGroup, SchemaElement, Type } from './gen/parquet_types';
import { ParquetSchema } from './schema';
import * as Shred from './shred';
import * as Util from './util';

/**
 * Parquet File Magic String
 */
const PARQUET_MAGIC = 'PAR1';

/**
 * Parquet File Format Version
 */
const PARQUET_VERSION = 1;

/**
 * Default Page and Row Group sizes
 */
const PARQUET_DEFAULT_PAGE_SIZE = 8192;
const PARQUET_DEFAULT_ROW_GROUP_SIZE = 4096;

/**
 * Repetition and Definition Level Encoding
 */
const PARQUET_RDLVL_TYPE = 'INT32';
const PARQUET_RDLVL_ENCODING = 'RLE';

/**
 * Write a parquet file to an output stream. The ParquetWriter will perform
 * buffering/batching for performance, so close() must be called after all rows
 * are written.
 */
export class ParquetWriter {

  /**
   * Convenience method to create a new buffered parquet writer that writes to
   * the specified file
   */
  static async openFile(schema: ParquetSchema, path: string, opts?: WriteStreamOptions): Promise<ParquetWriter> {
    const outputStream = await Util.osopen(path, opts);
    return ParquetWriter.openStream(schema, outputStream, opts);
  }

  /**
   * Convenience method to create a new buffered parquet writer that writes to
   * the specified stream
   */
  static async openStream(schema: ParquetSchema, outputStream: WriteStream, opts?: WriteStreamOptions): Promise<ParquetWriter> {
    if (!opts) {
      // tslint:disable-next-line:no-parameter-reassignment
      opts = {};
    }

    const envelopeWriter = await ParquetEnvelopeWriter.openStream(
      schema,
      outputStream,
      opts
    );

    return new ParquetWriter(schema, envelopeWriter, opts);
  }

  public schema: ParquetSchema;
  public envelopeWriter: ParquetEnvelopeWriter;
  public rowBuffer: Record<string, TODO>;
  public rowGroupSize: number;
  public closed: boolean;
  public userMetadata: Record<string, string>;
  public writer: any;

  /**
   * Create a new buffered parquet writer for a given envelope writer
   */
  constructor(schema: ParquetSchema, envelopeWriter: ParquetEnvelopeWriter, opts: TODO) {
    this.schema = schema;
    this.envelopeWriter = envelopeWriter;
    this.rowBuffer = {};
    this.rowGroupSize = opts.rowGroupSize || PARQUET_DEFAULT_ROW_GROUP_SIZE;
    this.closed = false;
    this.userMetadata = {};

    try {
      envelopeWriter.writeHeader();
    } catch (err) {
      envelopeWriter.close();
      throw err;
    }
  }

  /**
   * Append a single row to the parquet file. Rows are buffered in memory until
   * rowGroupSize rows are in the buffer or close() is called
   */
  async appendRow(row: Record<string, any>): Promise<void> {
    if (this.closed) {
      throw 'writer was closed';
    }

    Shred.shredRecord(this.schema, row, this.rowBuffer);

    if (this.rowBuffer.rowCount >= this.rowGroupSize) {
      await this.envelopeWriter.writeRowGroup(this.rowBuffer);
      this.rowBuffer = {};
    }
  }

  /**
   * Finish writing the parquet file and commit the footer to disk. This method
   * MUST be called after you are finished adding rows. You must not call this
   * method twice on the same object or add any rows after the close() method has
   * been called
   */
  async close(callback?: () => void): Promise<void> {
    if (this.closed) {
      throw 'writer was closed';
    }

    this.closed = true;

    if (this.rowBuffer.rowCount > 0 || this.rowBuffer.rowCount >= this.rowGroupSize) {
      await this.envelopeWriter.writeRowGroup(this.rowBuffer);
      this.rowBuffer = {};
    }

    await this.envelopeWriter.writeFooter(this.userMetadata);
    await this.envelopeWriter.close();
    this.envelopeWriter = null;

    if (callback) {
      callback();
    }
  }

  /**
   * Add key<>value metadata to the file
   */
  setMetadata(key: any, value: any): void {
    this.userMetadata[key.toString()] = value.toString();
  }

  /**
   * Set the parquet row group size. This values controls the maximum number
   * of rows that are buffered in memory at any given time as well as the number
   * of rows that are co-located on disk. A higher value is generally better for
   * read-time I/O performance at the tradeoff of write-time memory usage.
   */
  setRowGroupSize(cnt: number): void {
    this.rowGroupSize = cnt;
  }

  /**
   * Set the parquet data page size. The data page size controls the maximum
   * number of column values that are written to disk as a consecutive array
   */
  setPageSize(cnt: number): void {
    this.writer.setPageSize(cnt);
  }

}

/**
 * Create a parquet file from a schema and a number of row groups. This class
 * performs direct, unbuffered writes to the underlying output stream and is
 * intendend for advanced and internal users; the writeXXX methods must be
 * called in the correct order to produce a valid file.
 */
export class ParquetEnvelopeWriter {

  /**
   * Create a new parquet envelope writer that writes to the specified stream
   */
  static async openStream(schema: ParquetSchema, outputStream: Stream, opts): Promise<ParquetEnvelopeWriter> {
    const writeFn = Util.oswrite.bind(undefined, outputStream);
    const closeFn = Util.osclose.bind(undefined, outputStream);
    return new ParquetEnvelopeWriter(schema, writeFn, closeFn, 0, opts);
  }

  public schema: ParquetSchema;
  public write: (buf: Buffer) => void;
  public close: () => void;
  public offset: number;
  public rowCount: number;
  public rowGroups: any[];
  public pageSize: number;
  public useDataPageV2: boolean;

  constructor(schema: ParquetSchema, writeFn: (buf: Buffer) => void, closeFn: () => void, fileOffset: number, opts) {
    this.schema = schema;
    this.write = writeFn;
    this.close = closeFn;
    this.offset = fileOffset;
    this.rowCount = 0;
    this.rowGroups = [];
    this.pageSize = PARQUET_DEFAULT_PAGE_SIZE;
    this.useDataPageV2 = ('useDataPageV2' in opts) ? opts.useDataPageV2 : true;
  }

  writeSection(buf): void {
    this.offset += buf.length;
    return this.write(buf);
  }

  /**
   * Encode the parquet file header
   */
  writeHeader(): void {
    return this.writeSection(Buffer.from(PARQUET_MAGIC));
  }

  /**
   * Encode a parquet row group. The records object should be created using the
   * shredRecord method
   */
  writeRowGroup(records): void {
    const rgroup = encodeRowGroup(
      this.schema,
      records,
      {
        baseOffset: this.offset,
        pageSize: this.pageSize,
        useDataPageV2: this.useDataPageV2
      }
    );

    this.rowCount += records.rowCount;
    this.rowGroups.push(rgroup.metadata);
    return this.writeSection(rgroup.body);
  }

  /**
   * Write the parquet file footer
   */
  writeFooter(userMetadata) {
    if (!userMetadata) {
      // tslint:disable-next-line:no-parameter-reassignment
      userMetadata = {};
    }

    if (this.rowCount === 0) {
      throw 'cannot write parquet file with zero rows';
    }

    if (this.schema.fieldList.length === 0) {
      throw 'cannot write parquet file with zero fieldList';
    }

    return this.writeSection(
      encodeFooter(this.schema, this.rowCount, this.rowGroups, userMetadata));
  }

  /**
   * Set the parquet data page size. The data page size controls the maximum
   * number of column values that are written to disk as a consecutive array
   */
  setPageSize(cnt) {
    this.pageSize = cnt;
  }

}

/**
 * Create a parquet transform stream
 */
export class ParquetTransformer extends Transform {

  public writer: ParquetWriter;

  constructor(schema, opts = {}) {
    super({ objectMode: true });

    const writeProxy = (function (t) {
      return function (b) {
        t.push(b);
      };
    })(this);

    this.writer = new ParquetWriter(
      schema,
      new ParquetEnvelopeWriter(schema, writeProxy, () => ({}), 0, opts),
      opts);
  }

  // tslint:disable-next-line:function-name
  _transform(row, encoding, callback) {
    if (row) {
      this.writer.appendRow(row).then(callback);
    } else {
      callback();
    }
  }

  // tslint:disable-next-line:function-name
  _flush(callback) {
    this.writer.close(callback);
  }

}

/**
 * Encode a consecutive array of data using one of the parquet encodings
 */
function encodeValues(type, encoding, values, opts) {
  if (!(encoding in PARQUET_CODEC)) {
    throw 'invalid encoding: ' + encoding;
  }

  return PARQUET_CODEC[encoding].encodeValues(type, values, opts);
}

/**
 * Encode a parquet data page
 */
function encodeDataPage(column, valueCount, values, rlevels, dlevels) {
  /* encode values */
  const valuesBuf = encodeValues(
    column.primitiveType,
    column.encoding,
    values, {
      typeLength: column.typeLength,
      bitWidth: column.typeLength
    });

  /* encode repetition and definition levels */
  let rLevelsBuf = Buffer.alloc(0);
  if (column.rLevelMax > 0) {
    rLevelsBuf = encodeValues(
      PARQUET_RDLVL_TYPE,
      PARQUET_RDLVL_ENCODING,
      rlevels,
      { bitWidth: Util.getBitWidth(column.rLevelMax) });
  }

  let dLevelsBuf = Buffer.alloc(0);
  if (column.dLevelMax > 0) {
    dLevelsBuf = encodeValues(
      PARQUET_RDLVL_TYPE,
      PARQUET_RDLVL_ENCODING,
      dlevels,
      { bitWidth: Util.getBitWidth(column.dLevelMax) });
  }

  /* build page header */
  const pageBody = Buffer.concat([rLevelsBuf, dLevelsBuf, valuesBuf]);
  const pageHeader = new PageHeader({
    type: PageType.DATA_PAGE,
    uncompressed_page_size: pageBody.length,
    compressed_page_size: pageBody.length,
    data_page_header: new DataPageHeader({
      num_values: valueCount,
      encoding: Encoding[column.encoding] as any,
      definition_level_encoding:
        Encoding[PARQUET_RDLVL_ENCODING], // [PARQUET_RDLVL_ENCODING],
      repetition_level_encoding:
        Encoding[PARQUET_RDLVL_ENCODING], // [PARQUET_RDLVL_ENCODING]
    })
  });

  /* concat page header, repetition and definition levels and values */
  return Buffer.concat([Util.serializeThrift(pageHeader), pageBody]);
}

/**
 * Encode a parquet data page (v2)
 */
function encodeDataPageV2(column, valueCount, rowCount, values, rlevels, dlevels) {
  /* encode values */
  const valuesBuf = encodeValues(
    column.primitiveType,
    column.encoding,
    values, {
      typeLength: column.typeLength,
      bitWidth: column.typeLength
    });

  const valuesBufCompressed = Compression.deflate(
    column.compression,
    valuesBuf);

  /* encode repetition and definition levels */
  let rLevelsBuf = Buffer.alloc(0);
  if (column.rLevelMax > 0) {
    rLevelsBuf = encodeValues(
      PARQUET_RDLVL_TYPE,
      PARQUET_RDLVL_ENCODING,
      rlevels, {
        bitWidth: Util.getBitWidth(column.rLevelMax),
        disableEnvelope: true
      });
  }

  let dLevelsBuf = Buffer.alloc(0);
  if (column.dLevelMax > 0) {
    dLevelsBuf = encodeValues(
      PARQUET_RDLVL_TYPE,
      PARQUET_RDLVL_ENCODING,
      dlevels, {
        bitWidth: Util.getBitWidth(column.dLevelMax),
        disableEnvelope: true
      });
  }

  /* build page header */
  const pageHeader = new PageHeader({
    type: PageType.DATA_PAGE_V2,
    data_page_header_v2: new DataPageHeaderV2({
      num_values: valueCount,
      num_nulls: valueCount - values.length,
      num_rows: rowCount,
      encoding: Encoding[column.encoding] as any,
      definition_levels_byte_length: dLevelsBuf.length,
      repetition_levels_byte_length: rLevelsBuf.length,
      is_compressed: column.compression !== 'UNCOMPRESSED'
    }),
    uncompressed_page_size: rLevelsBuf.length + dLevelsBuf.length + valuesBuf.length,
    compressed_page_size: rLevelsBuf.length + dLevelsBuf.length + valuesBufCompressed.length
  });

  /* concat page header, repetition and definition levels and values */
  return Buffer.concat([
    Util.serializeThrift(pageHeader),
    rLevelsBuf,
    dLevelsBuf,
    valuesBufCompressed]);
}

/**
 * Encode an array of values into a parquet column chunk
 */
function encodeColumnChunk(values, opts) {
  /* encode data page(s) */
  const pages = [];

  {
    let dataPage;
    if (opts.useDataPageV2) {
      dataPage = encodeDataPageV2(
        opts.column,
        values.count,
        opts.rowCount,
        values.values,
        values.rlevels,
        values.dlevels);
    } else {
      dataPage = encodeDataPage(
        opts.column,
        values.count,
        values.values,
        values.rlevels,
        values.dlevels);
    }

    pages.push(dataPage);
  }

  const pagesBuf = Buffer.concat(pages);

  /* prepare metadata header */
  const metadata = new ColumnMetaData({
    path_in_schema: opts.column.path,
    num_values: values.count,
    data_page_offset: opts.baseOffset,
    encodings: [],
    total_uncompressed_size: pagesBuf.length,
    total_compressed_size: pagesBuf.length,
    type: Type[opts.column.primitiveType] as any,
    codec: CompressionCodec[opts.useDataPageV2 ? opts.column.compression : 'UNCOMPRESSED'] as any
  });

  /* list encodings */
  const encodingsSet = {};
  encodingsSet[PARQUET_RDLVL_ENCODING] = true;
  encodingsSet[opts.column.encoding] = true;
  for (const k in encodingsSet) {
    metadata.encodings.push(Encoding[k]);
  }

  /* concat metadata header and data pages */
  const metadataOffset = opts.baseOffset + pagesBuf.length;
  const body = Buffer.concat([pagesBuf, Util.serializeThrift(metadata)]);
  return { body, metadata, metadataOffset };
}

/**
 * Encode a list of column values into a parquet row group
 */
function encodeRowGroup(schema: ParquetSchema, data, opts): { body: Buffer, metadata: TODO } {
  const metadata = new RowGroup({
    num_rows: data.rowCount,
    columns: [],
    total_byte_size: 0
  });

  let body = Buffer.alloc(0);
  for (const field of schema.fieldList) {
    if (field.isNested) {
      continue;
    }

    const cchunkData = encodeColumnChunk(
      data.columnData[field.path as any],
      {
        column: field,
        baseOffset: opts.baseOffset + body.length,
        pageSize: opts.pageSize,
        encoding: field.encoding,
        rowCount: data.rowCount,
        useDataPageV2: opts.useDataPageV2
      }
    );

    const cchunk = new ColumnChunk({
      file_offset: cchunkData.metadataOffset,
      meta_data: cchunkData.metadata
    });

    metadata.columns.push(cchunk);
    metadata.total_byte_size += cchunkData.body.length;

    body = Buffer.concat([body, cchunkData.body]);
  }

  return { body, metadata };
}

/**
 * Encode a parquet file metadata footer
 */
function encodeFooter(schema, rowCount, rowGroups, userMetadata) {
  const metadata = new FileMetaData({
    version: PARQUET_VERSION,
    created_by: 'parquets',
    num_rows: rowCount,
    row_groups: rowGroups,
    schema: [],
    key_value_metadata: []
  });

  for (const key in userMetadata) {
    const kv = new KeyValue({
      key,
      value: userMetadata[key]
    });
    metadata.key_value_metadata.push(kv);
  }

  {
    const schemaRoot = new SchemaElement({
      name: 'root',
      num_children: Object.keys(schema.fields).length
    });
    metadata.schema.push(schemaRoot);
  }

  for (const field of schema.fieldList) {
    const relt = FieldRepetitionType[field.repetitionType];
    const schemaElem = new SchemaElement({
      name: field.name,
      repetition_type: relt as any
    });

    if (field.isNested) {
      schemaElem.num_children = field.fieldCount;
    } else {
      schemaElem.type = Type[field.primitiveType] as TODO;
    }

    if (field.originalType) {
      schemaElem.converted_type = ConvertedType[field.originalType] as TODO;
    }

    schemaElem.type_length = field.typeLength;

    metadata.schema.push(schemaElem);
  }

  const metadataEncoded = Util.serializeThrift(metadata);
  const footerEncoded = Buffer.alloc(metadataEncoded.length + 8);
  metadataEncoded.copy(footerEncoded);
  footerEncoded.writeUInt32LE(metadataEncoded.length, metadataEncoded.length);
  footerEncoded.write(PARQUET_MAGIC, metadataEncoded.length + 4);
  return footerEncoded;
}
