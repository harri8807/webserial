# Web Serial Debug

浏览器串口调试工具

仅测试了 Edge 和 Chrome 浏览器,其他浏览器未测试是否可用

同时支持 USB 串口与低功耗蓝牙（BLE）串口，两种物理连接共用日志、快捷发送和循环发送功能。

在线体验: [https://itldg.github.io/web-serial-debug/](https://itldg.github.io/web-serial-debug/)

国内体验: [https://www.itldg.com/web_serial_debug/](https://www.itldg.com/web_serial_debug/)

## 界面预览

![界面预览](/imgs/main.png)

## 实现功能

-   自动重连,设备插拔自动重连
-   所有串口参数可设置更改,配置自动保存
-   串口日志支持 HEX, TEXT 和 彩色ANSI,自动滚动
-   分包合并,设定超时时间
-   快捷发送列表,自定义分组,支持从工程目录自动加载配置
-   配置文件导入导出,方便迁移
-   自定义脚本,支持发送和接收数据处理

## 使用方法

先选择一个电脑连接的串口

调整串口参数后打开串口即可开始通讯

### 蓝牙 BLE 连接

1. 在左侧连接方式中切换到“蓝牙 BLE”。
2. 点击“搜索设备”，在浏览器弹出的设备列表中选择设备。
3. 点击“连接蓝牙”。页面会自动识别 Nordic UART、HM-10/FFE0、FFF0 等常见 BLE 串口服务。
4. 如果设备使用厂商自定义服务，在“高级设置”中选择“自定义 UUID”并填写服务、接收、发送 UUID。

Web Bluetooth 仅支持 BLE，不支持 HC-05/HC-06 等经典蓝牙 SPP 设备。页面必须通过 HTTPS 或 `localhost` 打开；`file://` 直接打开无法使用蓝牙。

自定义 UUID 模式下只需要填写**服务 UUID**，接收/发送 UUID 留空即可由页面自动识别。但服务 UUID 必须填写：浏览器只会授权访问 `optionalServices` 中申请过的服务，没有申请的服务在连接后会报 `SecurityError`。

高级设置说明：

| 选项 | 说明 |
| --- | --- |
| 名称前缀 | 只显示名称匹配前缀的设备，留空显示全部 |
| BLE 单包 | 单次写入的字节数，不能超过设备协商的 MTU-3（默认 20 字节），超出会写入失败 |
| 包间隔 | 分片之间的等待毫秒数。部分模块连续收包会丢数据，OTA 时可适当调大；调到 0 则全速发送 |
| 写入方式 | 自动 / 有响应 / 无响应。特征值只支持一种方式时页面会自动回退 |

如果 OTA 升级在蓝牙下经常超时，可以尝试把“BLE 单包”调大到模块实际支持的 MTU（如 100~244），并把“包间隔”调小到 0。

中间区域是串口日志,可以选择 HEX ,TEXT 或者 彩色ANSI 显示

下方是发送区域,可以选择 HEX 或者 TEXT 发送,定时循环发送

右侧可以自己添加一些常用指令,快捷发送。如果在工程根目录下有 `quicksend-config.json` 文件，页面会自动加载快捷发送配置

## 自定义脚本

自定义脚本可以在发送和接收数据时进行处理

脚本支持 JavaScript 语法,通过`postMessage`和`onmessage`进行通讯

如下是一个简单的脚本示例

```javascript
addEventListener('message', function ({data}) {
    if(data.type=='uart_receive')
    {
        postMessage({type:'log',data:'消息长度:'+data.data.length});
        //原文答复
        postMessage({type:'uart_send',data:data.data});
    }
})
setInterval(function(){
    //定时发送
    postMessage({type:'uart_send_txt',data:'hello world'});
},1000);
```

`onmessage`接收到的数据格式如下

```js
{
    "type":"uart_receive", //消息类型 String,目前仅支持 uart_receive
    "data":[0,1] //消息内容 Uint8Array
}
```

`postMessage`发送的数据格式如下

```js
{
    "type":"uart_send", 
    "data":[0,1]
}
```

| TYPE 类型     | DATA 数据格式 | 说明               |
| ------------- | ------------- | ------------------ |
| uart_send     | Uint8Array    | 发送字节数据       |
| uart_send_txt | String        | 发送文本数据       |
| uart_send_hex | String        | 发送十六进制字符串 |
| log           | String        | 打印日志           |


## 开源

代码凌乱不堪，无学习价值

希望各位大佬可以协助添砖加瓦，让其更加完善

常用的朋友也可以提交一些常用的指令集,后续做一下常用指令集的整理

开源地址：[GitHub](https://github.com/itldg/web-serial-debug) | [Gitee](https://gitee.com/itldg/web-serial-debug)
