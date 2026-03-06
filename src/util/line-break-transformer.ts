export class LineBreakTransformer implements Transformer<string, string> {
  private chunks = "";

  transform(
    chunk: string,
    controller: TransformStreamDefaultController<string>,
  ) {
    // 将新块追加到现有块中
    this.chunks += chunk;
    // 对于块中的每个换行符，将解析出的行发送出去
    const lines = this.chunks.split("\r\n");
    this.chunks = lines.pop()!;
    lines.forEach((line) => controller.enqueue(line + "\r\n"));
  }

  flush(controller: TransformStreamDefaultController<string>) {
    // 当流关闭时，刷新所有剩余的块
    controller.enqueue(this.chunks);
  }
}
