/**
 * アイコンの写真を、真ん中を正方形に切り取り、256px の JPEG にする。
 * アイコンは小さく出るので、大きいまま持つ意味がない（保存も転送も小さくなる）。
 * この端末で読めない画像（Chrome で iPhone の HEIC など）は、エラーにする
 */
export async function squareImage(f: File, side = 256): Promise<Blob> {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    const s = Math.min(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // 透明の部分は白に（JPEG は透明を持てないため）
    ctx.fillRect(0, 0, side, side);
    ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, side, side);
    bmp.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('image');
    return blob;
  }