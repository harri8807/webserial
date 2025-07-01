// 新增协议状态机和默认配置
const ProtocolStates = {
    IDLE: 'IDLE',
    SENDING: 'SENDING',
    WAITING_ACK: 'WAITING_ACK',
    COMPLETED: 'COMPLETED',
    ERROR: 'ERROR'
};

const DEFAULT_CONFIG = {
    maxRetries: 10,
    timeout: 3000,
    blockSize: 1024,
    soh: 0x01,
    stx: 0x02,
    crcEnabled: false
};

class YModem {
    constructor() {
        // YModem 协议常量
        this.SOH = 0x01;       // 128字节数据块标志
        this.STX = 0x02;       // 1024字节数据块标志
        this.EOT = 0x04;       // 传输结束标志
        this.ACK = 0x06;       // 确认
        this.NAK = 0x15;       // 否定确认
        this.CAN = 0x18;       // 取消传输
        this.C = 0x43;         // ASCII 'C'，CRC模式请求

        // 状态变量
        this.state = 'IDLE';   // 当前状态
        this.fileName = '';    // 文件名
        this.fileSize = 0;     // 文件大小
        this.fileData = null;  // 文件数据
        this.filePos = 0;      // 当前文件位置
        this.blockNum = 0;     // 当前块编号
        this.retries = 0;      // 重试次数
        this.maxRetries = 10;  // 最大重试次数
        this.lastPacket = null;// 最后发送的数据包

        // 1K模式设置
        this.use1K = true;     // 使用1K数据包
        this.dataPacketSize = 1024; // 数据包大小
        
        // 日志级别
        this.logLevel = 'info'; // debug, info, warn, error
    }

    /**
     * 输出日志
     * @param {string} level - 日志级别
     * @param {string} message - 日志消息
     */
    log(level, message) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        const colors = { debug: '#888', info: '#00f', warn: '#f80', error: '#f00' };
        
        if (levels[level] >= levels[this.logLevel]) {
            console.log(`%c[YModem] ${message}`, `color: ${colors[level]}`);
        }
    }

    /**
     * 计算CRC16校验码（CCITT-XMODEM标准）
     * @param {Uint8Array} data - 需要计算CRC的数据
     * @returns {number} - CRC16校验值
     */
    calcCRC16(data) {
        let crc = 0;
        for (let i = 0; i < data.length; i++) {
            crc ^= (data[i] << 8);
            for (let j = 0; j < 8; j++) {
                if (crc & 0x8000) {
                    crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
                } else {
                    crc = (crc << 1) & 0xFFFF;
                }
            }
        }
        return crc;
    }

    /**
     * 启动YModem传输
     * @param {File} file - 要传输的文件
     * @param {Function} sendCallback - 发送数据回调
     * @param {Function} progressCallback - 进度回调
     * @param {Function} successCallback - 成功回调
     * @param {Function} errorCallback - 错误回调
     */
    async start(file, sendCallback, progressCallback, successCallback, errorCallback) {
        this.log('info', `开始YModem传输: ${file.name}, 大小: ${file.size} 字节`);
        this.fileName = file.name;
        this.fileSize = file.size;
        this.fileData = new Uint8Array(await file.arrayBuffer());
        this.filePos = 0;
        this.blockNum = 0;
        this.retries = 0;
        this.state = 'WAIT_C';
        
        this.sendCallback = sendCallback;
        this.progressCallback = progressCallback;
        this.successCallback = successCallback;
        this.errorCallback = errorCallback;
        
        this.log('info', `YModem模式: ${this.use1K ? '1K (1024字节)' : '标准 (128字节)'}`);
        this.log('info', '等待设备发送C字符...');
    }

    /**
     * 处理接收到的字节
     * @param {number} byte - 接收到的字节
     */
    async handleByte(byte) {
        // 将字节转换为16进制字符串，方便日志显示
        const byteHex = ('0' + byte.toString(16).toUpperCase()).slice(-2);
        const byteChar = byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
        
        this.log('debug', `收到字节: 0x${byteHex} (${byteChar}), 当前状态: ${this.state}`);
        
        switch (this.state) {
            case 'WAIT_C':
                if (byte === this.C) {
                    this.log('info', '收到C字符，发送文件名包');
                    await this.sendFileInfoPacket();
                    this.state = 'WAIT_ACK_FILE_INFO';
                    this.retries = 0;
                }
                break;
                
            case 'WAIT_ACK_FILE_INFO':
                if (byte === this.ACK) {
                    this.log('info', '文件信息包已确认，等待第二个C字符');
                    this.state = 'WAIT_C_AFTER_ACK';
                } else if (byte === this.NAK) {
                    this.log('warn', '文件信息包被拒绝，重试');
                    this.retries++;
                    if (this.retries <= this.maxRetries) {
                        await this.sendFileInfoPacket();
                    } else {
                        this.errorCallback('发送文件信息包失败，重试次数过多');
                        this.state = 'ERROR';
                    }
                }
                break;
                
            case 'WAIT_C_AFTER_ACK':
                if (byte === this.C) {
                    this.log('info', '收到第二个C字符，开始发送数据块');
                    this.blockNum = 1; // 从块1开始
                    await this.sendDataPacket();
                    this.state = 'WAIT_ACK_DATA';
                    this.retries = 0;
                }
                break;
                
            case 'WAIT_ACK_DATA':
                if (byte === this.ACK) {
                    // 数据块已确认，更新位置和进度
                    this.filePos += this.dataPacketSize;
                    const progress = Math.min(100, Math.floor((this.filePos * 100) / this.fileSize));
                    this.log('info', `数据块${this.blockNum}已确认，进度: ${progress}%`);
                    this.progressCallback(progress);
                    
                    if (this.filePos >= this.fileSize) {
                        // 所有数据已发送，发送EOT
                        this.log('info', '所有数据已发送，发送第一个EOT');
                        await this.sendEOT();
                        this.state = 'WAIT_NAK_AFTER_EOT';
                        this.retries = 0;
                    } else {
                        // 发送下一个数据块
                        this.blockNum = (this.blockNum + 1) & 0xFF;
                        if (this.blockNum === 0) this.blockNum = 1; // 避免使用块0
                        await this.sendDataPacket();
                        this.retries = 0;
                    }
                } else if (byte === this.NAK) {
                    this.log('warn', `数据块${this.blockNum}被拒绝，重试`);
                    this.retries++;
                    if (this.retries <= this.maxRetries) {
                        await this.resendLastPacket();
                    } else {
                        this.errorCallback('发送数据块失败，重试次数过多');
                        this.state = 'ERROR';
                    }
                } else if (byte === this.CAN) {
                    this.log('error', '收到取消请求');
                    this.errorCallback('传输被设备取消');
                    this.state = 'ERROR';
                }
                break;
                
            case 'WAIT_NAK_AFTER_EOT':
                if (byte === this.NAK) {
                    this.log('info', '收到对第一个EOT的NAK，发送第二个EOT');
                    await this.sendEOT();
                    this.state = 'WAIT_ACK_AFTER_EOT';
                    this.retries = 0;
                } else if (byte === this.ACK) {
                    // 有些设备可能会直接确认第一个EOT
                    this.log('info', '收到对第一个EOT的ACK（非标准响应），发送结束包');
                    await this.sendNullPacket();
                    this.state = 'WAIT_ACK_NULL';
                    this.retries = 0;
                }
                break;
                
            case 'WAIT_ACK_AFTER_EOT':
                if (byte === this.ACK) {
                    this.log('info', '收到对第二个EOT的ACK，发送结束包');
                    await this.sendNullPacket();
                    this.state = 'WAIT_ACK_NULL';
                    this.retries = 0;
                } else if (byte === this.NAK) {
                    this.log('warn', '第二个EOT被拒绝，重试');
                    this.retries++;
                    if (this.retries <= this.maxRetries) {
                        await this.sendEOT();
                    } else {
                        this.errorCallback('发送EOT失败，重试次数过多');
                        this.state = 'ERROR';
                    }
                }
                break;
                
            case 'WAIT_ACK_NULL':
                if (byte === this.ACK) {
                    this.log('info', '结束包已确认，传输完成');
                    this.state = 'DONE';
                    this.progressCallback(100);
                    this.successCallback();
                } else if (byte === this.NAK) {
                    this.log('warn', '结束包被拒绝，重试');
                    this.retries++;
                    if (this.retries <= this.maxRetries) {
                        await this.sendNullPacket();
                    } else {
                        this.errorCallback('发送结束包失败，重试次数过多');
                        this.state = 'ERROR';
                    }
                }
                break;
                
            case 'ERROR':
            case 'DONE':
                // 这些状态下忽略所有输入
                break;
                
            default:
                this.log('warn', `未处理的状态: ${this.state}`);
                break;
        }
    }

    /**
     * 发送文件信息包
     */
    async sendFileInfoPacket() {
        // 始终使用128字节包发送文件信息
        const packet = new Uint8Array(128);
        
        // 添加文件名，以null结尾
        const nameBytes = new TextEncoder().encode(this.fileName);
        let pos = 0;
        for (let i = 0; i < nameBytes.length && pos < packet.length; i++) {
            packet[pos++] = nameBytes[i];
        }
        packet[pos++] = 0; // 文件名结束标记
        
        // 添加文件大小字符串，以空格和null结尾
        const sizeStr = this.fileSize.toString() + ' ';
        const sizeBytes = new TextEncoder().encode(sizeStr);
        for (let i = 0; i < sizeBytes.length && pos < packet.length; i++) {
            packet[pos++] = sizeBytes[i];
        }
        packet[pos++] = 0; // 文件大小结束标记
        
        // 余下部分保持为0
        for (let i = pos; i < packet.length; i++) {
            packet[pos++] = 0;
        }
        
        await this.sendPacket(0, packet, false);
    }

    /**
     * 发送数据包
     */
    async sendDataPacket() {
        const dataSize = this.use1K ? 1024 : 128;
        const packet = new Uint8Array(dataSize);
        
        // 确定本次传输的数据大小
        const remaining = this.fileSize - this.filePos;
        const bytesToSend = Math.min(dataSize, remaining);
        
        if (bytesToSend > 0) {
            // 复制实际数据
            packet.set(this.fileData.subarray(this.filePos, this.filePos + bytesToSend), 0);
            
            // 如果数据不足一个包，用0x1A填充
            if (bytesToSend < dataSize) {
                for (let i = bytesToSend; i < dataSize; i++) {
                    packet[i] = 0x1A; // SUB字符
                }
            }
        } else {
            // 如果没有更多数据，全部填充0x1A
            packet.fill(0x1A);
        }
        
        this.log('debug', `发送数据块${this.blockNum}: ${bytesToSend}字节，位置: ${this.filePos}`);
        await this.sendPacket(this.blockNum, packet, this.use1K);
    }

    /**
     * 发送结束包（空包）
     */
    async sendNullPacket() {
        const packet = new Uint8Array(128).fill(0); // 全0包
        await this.sendPacket(0, packet, false);
    }

    /**
     * 发送数据包
     * @param {number} blockNum - 块编号
     * @param {Uint8Array} data - 数据
     * @param {boolean} use1K - 是否使用1K包
     */
    async sendPacket(blockNum, data, use1K) {
        const packetSize = use1K ? 1024 : 128;
        const header = use1K ? this.STX : this.SOH;
        
        // 创建完整数据包: 头(1) + 块号(1) + 块号反码(1) + 数据(1024/128) + CRC(2)
        const fullPacket = new Uint8Array(3 + packetSize + 2);
        
        // 设置头部
        fullPacket[0] = header;
        fullPacket[1] = blockNum;
        fullPacket[2] = 255 - blockNum;
        
        // 设置数据
        fullPacket.set(data, 3);
        
        // 计算CRC
        const crc = this.calcCRC16(data);
        fullPacket[3 + packetSize] = (crc >> 8) & 0xFF; // CRC高字节
        fullPacket[3 + packetSize + 1] = crc & 0xFF;    // CRC低字节
        
        this.log('debug', `发送${use1K ? '1K' : '128字节'}包，块号: ${blockNum}, CRC: 0x${crc.toString(16).toUpperCase()}`);
        this.lastPacket = fullPacket;
        await this.sendCallback(fullPacket);
    }

    /**
     * 重发上一个数据包
     */
    async resendLastPacket() {
        if (this.lastPacket) {
            this.log('debug', '重发上一个数据包');
            await this.sendCallback(this.lastPacket);
        } else {
            this.log('error', '没有可重发的数据包');
        }
    }

    /**
     * 发送EOT（传输结束）
     */
    async sendEOT() {
        this.log('debug', '发送EOT');
        await this.sendCallback(new Uint8Array([this.EOT]));
    }
}

// 兼容性处理：确保window.YModem和window.Ymodem都可用
window.YModem = YModem;
window.Ymodem = YModem;