/*
 * BLE serial transport.
 *
 * Web Bluetooth requires a secure context (HTTPS or localhost). This class
 * intentionally keeps the transport API small so the existing serial UI can
 * use the same send/receive path for both physical connections.
 */
;(function () {
	const KNOWN_PROFILES = {
		nordic: {
			name: 'Nordic UART',
			service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
			rx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
			tx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
		},
		ffe0: {
			name: 'HM-10 / FFE0',
			service: '0000ffe0-0000-1000-8000-00805f9b34fb',
			rx: '0000ffe1-0000-1000-8000-00805f9b34fb',
			tx: '0000ffe1-0000-1000-8000-00805f9b34fb',
		},
		fff0: {
			name: 'FFF0 Serial',
			service: '0000fff0-0000-1000-8000-00805f9b34fb',
			rx: '0000fff1-0000-1000-8000-00805f9b34fb',
			tx: '0000fff2-0000-1000-8000-00805f9b34fb',
		},
	}

	const STANDARD_SERVICES = [
		KNOWN_PROFILES.nordic.service,
		KNOWN_PROFILES.ffe0.service,
		KNOWN_PROFILES.fff0.service,
	]

	// 扫描过滤模式:
	// supported - 只显示"已知/支持"的设备(默认)。浏览器选择器里只列出广播包中
	//             advertised 了已知串口服务 UUID 的设备, 未知设备(没有名称、
	//             不广播服务)和不支持的设备(耳机、手环、键鼠等)都不会出现。
	// all       - 显示全部设备, 用于排查"明明设备在旁边却搜不到"的情况。
	const FILTER_MODE_SUPPORTED = 'supported'
	const FILTER_MODE_ALL = 'all'

	// Web Bluetooth 单次写入的上限: 属性值最长 512 字节(Long Attribute Values)。
	const MAX_WRITE_BYTES = 512
	// 透传模块一般协商 ATT MTU 247, 扣掉 3 字节 ATT 头后单包可用 244 字节。
	// 数据不超过该值时整包发出, 模块只收到一帧, 不会被拆成多个小包。
	const DEFAULT_CHUNK_SIZE = 244
	// 降级下限: 默认 ATT MTU 23 时可用 20 字节, 再小就没意义了。
	const MIN_CHUNK_SIZE = 20

	function normalizeUuid(uuid) {
		const value = String(uuid || '').trim().toLowerCase()
		if (!value) return ''
		if (/^[0-9a-f]{4}$/.test(value)) {
			return `0000${value}-0000-1000-8000-00805f9b34fb`
		}
		if (/^[0-9a-f]{8}$/.test(value)) {
			return `${value}-0000-1000-8000-00805f9b34fb`
		}
		return value
	}

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	// 把 DOMException 转换成便于排查的中文描述
	function describeError(error) {
		const name = error?.name || ''
		if (name === 'SecurityError') {
			return '服务未授权（该服务 UUID 不在 optionalServices 中，请在高级设置中手动填写）'
		}
		if (name === 'NotFoundError') {
			return '服务或特征值不存在'
		}
		if (name === 'NetworkError') {
			return 'GATT 通信失败，设备可能已断开或被其他程序占用'
		}
		if (name === 'InvalidStateError') {
			return '当前状态不允许该操作（特征值可能不支持这种写入方式）'
		}
		return error?.message || String(error)
	}

	class BleSerialTransport {
		constructor(options = {}) {
			this.device = null
			this.server = null
			this.service = null
			this.rxCharacteristic = null
			this.txCharacteristic = null
			this.rxSubscription = null
			this.writeChain = Promise.resolve()
			// 接收串行化链: onData 是异步的(OTA 时要 await ymodem.handleByte),
			// 通知回调本身是同步的, 密集到达时会并发执行, 需要排队。
			this.rxChain = Promise.resolve()
			this.connected = false
			this.disconnecting = false
			this.profile = null
			this.disconnectHandler = options.onDisconnect || (() => {})
			this.onData = null
			this.onError = null
			// 单包上限: 一次 writeValue() 最多写多少字节。
			// 数据长度不超过它时整包发送, 透传模块收到的是完整的一帧。
			this.chunkSize = DEFAULT_CHUNK_SIZE
			// 实际探测到的可用单包大小(写入失败降级后得到), null 表示还没探测过。
			this.packetSize = null
			// 单包大小被自动降级时通知外部, 用于更新界面提示。
			this.onPacketSizeChange = options.onPacketSizeChange || null
			// 分片之间的间隔(ms)。部分模块连续收包会丢数据, 留一点间隔更稳。
			this.writeDelay = 8
			this.writeMode = 'auto'
			this.onDisconnectBound = this.handleDisconnect.bind(this)
		}

		static get supported() {
			return typeof navigator !== 'undefined' && !!navigator.bluetooth
		}

		static get profiles() {
			return KNOWN_PROFILES
		}

		static get filterModes() {
			return {
				supported: FILTER_MODE_SUPPORTED,
				all: FILTER_MODE_ALL,
			}
		}

		setDisconnectHandler(handler) {
			this.disconnectHandler = handler || (() => {})
		}

		// 根据当前配置算出扫描时用于过滤的服务 UUID 列表。
		// 过滤规则和连接时的特征查找规则保持一致, 避免"列表里能选到、
		// 连上却找不到特征"的情况。
		resolveFilterServices(options = {}) {
			const profile = options.profile || 'auto'
			const customService = normalizeUuid(options.serviceUuid)
			const knownServices = Object.values(KNOWN_PROFILES).map(
				(item) => item.service
			)

			if (profile === 'custom') {
				// 自定义模式没填服务 UUID 时, 退回已知服务, 保证搜索列表不为空。
				return customService ? [customService] : knownServices
			}

			if (profile !== 'auto') {
				const known = KNOWN_PROFILES[profile]
				return known ? [known.service] : knownServices
			}

			// 自动识别: 已知服务 + 用户填写的自定义服务
			const services = knownServices.slice()
			if (customService && !services.includes(customService)) {
				services.push(customService)
			}
			return services
		}

		async requestDevice(options = {}) {
			if (!BleSerialTransport.supported) {
				throw new Error('当前浏览器不支持 Web Bluetooth，请使用最新版 Chrome 或 Edge')
			}
			if (!window.isSecureContext) {
				throw new Error('蓝牙需要 HTTPS 或 localhost 安全环境，请通过本地 HTTP 服务器打开页面')
			}

			const namePrefix = String(options.namePrefix || '').trim()
			const serviceUuid = normalizeUuid(options.serviceUuid)
			const filterMode =
				options.filterMode === FILTER_MODE_ALL
					? FILTER_MODE_ALL
					: FILTER_MODE_SUPPORTED

			const requestOptions = {
				acceptAllDevices: false,
				optionalServices: STANDARD_SERVICES.slice(),
			}

			if (serviceUuid && !requestOptions.optionalServices.includes(serviceUuid)) {
				requestOptions.optionalServices.push(serviceUuid)
			}

			if (filterMode === FILTER_MODE_ALL) {
				// 显示全部设备: 只按名称前缀过滤。
				if (namePrefix) {
					requestOptions.filters = [{ namePrefix }]
				} else {
					requestOptions.acceptAllDevices = true
				}
			} else {
				// 只显示支持的设备: Web Bluetooth 只能通过 filters 让浏览器
				// 选择器过滤设备, 多个 filter 之间是"或"的关系。
				// services 过滤器匹配的是设备广播包里 advertised 的服务 UUID,
				// 所以没广播串口服务的设备(未知设备、非串口设备)不会出现在列表里。
				// 注意: 有些厂商私有服务的透传模块本身不广播服务 UUID,
				// 这类设备需要把"设备过滤"切换成"全部设备"才能选到。
				const services = this.resolveFilterServices(options)
				const filters = services.map((service) =>
					namePrefix
						? { services: [service], namePrefix }
						: { services: [service] }
				)
				if (filters.length) {
					requestOptions.filters = filters
				} else {
					// filters 为空浏览器会抛 TypeError, 兜底显示全部设备。
					requestOptions.acceptAllDevices = true
				}
			}

			const device = await navigator.bluetooth.requestDevice(requestOptions)
			this.device = device
			return device
		}

		async connect(options = {}) {
			if (!this.device) {
				throw new Error('请先搜索并选择蓝牙设备')
			}
			if (!this.device.gatt) {
				throw new Error('该设备不支持 GATT 连接')
			}
			if (this.connected) return
			this.disconnecting = false
			if (!this.rxSubscription) {
				this.rxSubscription = this.handleNotification.bind(this)
			}

			this.setChunkSize(options.chunkSize)
			this.writeMode = options.writeMode || 'auto'
			const delay = parseInt(options.writeDelay, 10)
			this.writeDelay = Number.isFinite(delay) ? Math.max(0, Math.min(200, delay)) : 8
			this.writeChain = Promise.resolve()
			this.rxChain = Promise.resolve()
			if (options.onDisconnect) this.disconnectHandler = options.onDisconnect
			this.device.removeEventListener('gattserverdisconnected', this.onDisconnectBound)
			this.device.addEventListener('gattserverdisconnected', this.onDisconnectBound)

			try {
				this.server = await this.device.gatt.connect()
				const resolved = await this.resolveCharacteristics(options)
				this.service = resolved.service
				this.rxCharacteristic = resolved.rx
				this.txCharacteristic = resolved.tx
				this.profile = resolved.profile

				this.rxCharacteristic.addEventListener(
					'characteristicvaluechanged',
					this.rxSubscription
				)
				await this.rxCharacteristic.startNotifications()
				this.connected = true
			} catch (error) {
				this.disconnecting = false
				this.connected = false
				try {
					this.device.gatt?.disconnect()
				} catch (_) {}
				throw this.friendlyError(error)
			}
		}

		async resolveCharacteristics(options) {
			const requestedProfile = options.profile || 'auto'
			const customService = normalizeUuid(options.serviceUuid)
			const customRx = normalizeUuid(options.rxUuid)
			const customTx = normalizeUuid(options.txUuid)

			if (requestedProfile === 'custom') {
				if (!customService) {
					throw new Error('自定义模式需要填写服务 UUID（接收/发送 UUID 可留空自动识别）')
				}
				return this.resolveFromService(customService, customRx, customTx, {
					name: '自定义 UUID',
					service: customService,
					rx: customRx,
					tx: customTx,
				})
			}

			if (requestedProfile !== 'auto') {
				const profile = KNOWN_PROFILES[requestedProfile]
				if (!profile) throw new Error(`未知的蓝牙串口配置: ${requestedProfile}`)
				return this.resolveFromService(profile.service, profile.rx, profile.tx, profile)
			}

			// 先尝试内置的常见串口服务, 再尝试用户填写的自定义服务。
			// 顺序很重要: 用户可能在"自定义"模式填过 UUID 后切回"自动识别",
			// 那时输入框里的值仍然存在, 不能因此把内置 profile 全部跳过。
			const preferred = Object.values(KNOWN_PROFILES)
			if (customService) {
				preferred.push({
					name: '自定义 UUID',
					service: customService,
					rx: customRx,
					tx: customTx,
				})
			}
			const failures = []

			for (const profile of preferred) {
				try {
					const service = await this.server.getPrimaryService(profile.service)
					const rx = profile.rx
						? await service.getCharacteristic(profile.rx)
						: await this.findNotifyCharacteristic(service)
					const tx = profile.tx
						? await service.getCharacteristic(profile.tx)
						: await this.findWriteCharacteristic(service)
					if (!rx) throw new Error('未找到接收特征')
					if (!tx) throw new Error('未找到发送特征')
					if (!rx.properties.notify && !rx.properties.indicate) {
						throw new Error('接收特征不支持通知')
					}
					if (!tx.properties.write && !tx.properties.writeWithoutResponse) {
						throw new Error('发送特征不支持写入')
					}
					return { service, rx, tx, profile }
				} catch (error) {
					failures.push(`${profile.name}: ${describeError(error)}`)
				}
			}

			// 兜底: 枚举浏览器已授权的服务, 找一对"通知 + 写入"特征。
			// 注意浏览器只暴露 optionalServices 里申请过的服务, 所以这里
			// 只能看到上面已经尝试过的那些, 无法凭空发现未申请的服务。
			try {
				const services = await this.server.getPrimaryServices()
				for (const service of services) {
					try {
						const rx = await this.findNotifyCharacteristic(service)
						const tx = await this.findWriteCharacteristic(service)
						return {
							service,
							rx,
							tx,
							profile: {
								name: `自动识别 (${service.uuid})`,
								service: service.uuid,
								rx: rx.uuid,
								tx: tx.uuid,
							},
						}
					} catch (_) {}
				}
			} catch (error) {
				failures.push(`枚举服务: ${describeError(error)}`)
			}

			throw new Error(
				'未找到可用的 BLE 串口特征值。请确认设备使用通知/写入特征，或在高级设置中填写 UUID。' +
					(failures.length ? ` (${failures[0]})` : '')
			)
		}

		async resolveFromService(serviceUuid, rxUuid, txUuid, profile) {
			const service = await this.server.getPrimaryService(serviceUuid)
			let rx
			let tx

			if (rxUuid) {
				rx = await service.getCharacteristic(rxUuid)
			} else {
				rx = await this.findNotifyCharacteristic(service)
			}
			if (txUuid) {
				tx = await service.getCharacteristic(txUuid)
			} else {
				tx = await this.findWriteCharacteristic(service)
			}
			if (!rx.properties.notify && !rx.properties.indicate) {
				throw new Error(
					rxUuid
						? '接收 UUID 对应的特征不支持通知'
						: '服务中没有支持通知(Notify/Indicate)的特征值'
				)
			}
			if (!tx.properties.write && !tx.properties.writeWithoutResponse) {
				throw new Error(
					txUuid
						? '发送 UUID 对应的特征不支持写入'
						: '服务中没有支持写入(Write)的特征值'
				)
			}
			return { service, rx, tx, profile }
		}

		async findNotifyCharacteristic(service) {
			const characteristics = await service.getCharacteristics()
			const notify = characteristics.find(
				(item) => item.properties.notify || item.properties.indicate
			)
			if (notify) return notify
			// 串口透传场景一律基于通知接收, 不做轮询兜底。
			throw new Error('服务中没有通知特征')
		}

		async findWriteCharacteristic(service) {
			const characteristics = await service.getCharacteristics()
			const candidate = characteristics.find(
				(item) =>
					item.properties.write ||
					item.properties.writeWithoutResponse
			)
			if (!candidate) throw new Error('服务中没有写入特征')
			return candidate
		}

		handleNotification(event) {
			const value = event.target.value
			if (!value) return
			const bytes = new Uint8Array(
				value.buffer,
				value.byteOffset,
				value.byteLength
			)
			// Copy because the DataView may be reused by the BLE stack.
			const chunk = bytes.slice()
			// 通知回调是同步的, 而 onData 内部是异步的(OTA 时还要 await
			// ymodem.handleByte)。这里用一条 Promise 链把接收串行化,
			// 否则密集到达的通知会并发执行, 破坏 YMODEM 状态机。
			this.rxChain = this.rxChain
				.then(() => this.onData?.(chunk))
				.catch((error) => {
					this.onError?.(error)
				})
		}

		setChunkSize(value) {
			const size = parseInt(value, 10)
			this.chunkSize = Number.isFinite(size)
				? Math.max(1, Math.min(MAX_WRITE_BYTES, size))
				: DEFAULT_CHUNK_SIZE
			// 手动调整后, 之前自动降级得到的值不再适用, 重新按新值尝试。
			this.packetSize = null
			return this.chunkSize
		}

		// 写入失败时降级到更小的单包, 并通知外部更新界面。
		applyPacketSize(limit) {
			this.packetSize = limit
			if (this.onPacketSizeChange) {
				try {
					this.onPacketSizeChange(limit)
				} catch (_) {}
			}
		}

		// 是不是"包太大"导致写入失败? 只有这类错误才值得换小包重发。
		isSizeError(error) {
			const name = error?.name || ''
			return name === 'NetworkError'
		}

		async write(data) {
			if (!this.connected || !this.txCharacteristic) {
				throw new Error('蓝牙未连接')
			}

			// 抓住本次写入使用的特征值: 传输过程中掉线时 handleDisconnect()
			// 会把 this.txCharacteristic 置空, 直接用 this.xxx 会在下一个
			// 分片时抛 "Cannot read properties of null"。
			const tx = this.txCharacteristic
			const bytes =
				data instanceof Uint8Array ? data : new Uint8Array(data)
			const properties = tx.properties
			const canWriteWithResponse = !!properties.write
			const canWriteWithoutResponse = !!properties.writeWithoutResponse
			let useResponse

			if (this.writeMode === 'without') {
				useResponse = false
			} else if (this.writeMode === 'with') {
				useResponse = true
			} else {
				useResponse = canWriteWithResponse
			}
			// 特征值只支持一种写入方式时, 退回到它支持的那种, 否则
			// writeValueWithResponse 会抛 InvalidStateError。
			if (useResponse && !canWriteWithResponse) {
				useResponse = false
			}
			if (!useResponse && !canWriteWithoutResponse) {
				useResponse = true
			}

			const writeChunk = async (chunk) => {
				if (useResponse) {
					if (tx.writeValueWithResponse) {
						await tx.writeValueWithResponse(chunk)
					} else {
						await tx.writeValue(chunk)
					}
				} else {
					if (tx.writeValueWithoutResponse) {
						await tx.writeValueWithoutResponse(chunk)
					} else {
						await tx.writeValue(chunk)
					}
				}
			}

			const task = this.writeChain
				.then(async () => {
					// 单包上限: 优先用实际探测到的值, 没有则用界面设置的值。
					let limit = Math.max(
						1,
						Math.min(
							MAX_WRITE_BYTES,
							this.packetSize || this.chunkSize
						)
					)
					let offset = 0

					while (offset < bytes.length) {
						// 分片之间设备可能掉线, 这里要重新检查连接状态
						if (!this.connected) {
							throw new Error('蓝牙已断开，数据发送中断')
						}
						// 数据装得下一整包时一次写完(整包发送), 透传模块
						// 只会收到一帧数据, 不会被拆成多个小包。
						const end = Math.min(offset + limit, bytes.length)
						try {
							// writeValue() accepts a BufferSource; a Uint8Array view keeps
							// the packet byte-for-byte identical to the serial path.
							await writeChunk(bytes.slice(offset, end))
						} catch (error) {
							// 有响应写入失败说明这一帧没被设备接收, 可以安全地
							// 换更小的包重发当前这段数据(前面已发出的不会重发)。
							// 无响应写入可能已经把数据发到设备了, 自动重发会造成
							// 重复数据, 所以只提示不重试。
							if (
								!useResponse ||
								!this.isSizeError(error) ||
								limit <= MIN_CHUNK_SIZE ||
								!this.connected
							) {
								throw this.friendlyWriteError(error)
							}
							limit = Math.max(MIN_CHUNK_SIZE, Math.floor(limit / 2))
							this.applyPacketSize(limit)
							continue
						}
						offset = end
						// BLE stacks can drop back-to-back notifications. A small
						// gap keeps OTA packets reliable on lower-end modules.
						if (offset < bytes.length && this.writeDelay > 0) {
							await sleep(this.writeDelay)
						}
					}
				})
				.catch((error) => {
					throw this.friendlyWriteError(error)
				})
			this.writeChain = task.catch(() => {})
			return task
		}

		async disconnect() {
			if (this.disconnecting) return
			this.disconnecting = true
			this.connected = false
			this.device?.removeEventListener(
				'gattserverdisconnected',
				this.onDisconnectBound
			)
			try {
				if (this.rxCharacteristic && this.rxSubscription) {
					this.rxCharacteristic.removeEventListener(
						'characteristicvaluechanged',
						this.rxSubscription
					)
				}
				if (this.rxCharacteristic) {
					await this.rxCharacteristic.stopNotifications()
				}
			} catch (_) {}
			try {
				this.device?.gatt?.disconnect()
			} catch (_) {}
			this.server = null
			this.service = null
			this.rxCharacteristic = null
			this.txCharacteristic = null
			this.rxSubscription = null
			this.rxChain = Promise.resolve()
			// Reconnect needs a fresh notification listener on the next GATT
			// session, even though the same device object is reused.
			this.device?.addEventListener(
				'gattserverdisconnected',
				this.onDisconnectBound
			)
			this.disconnecting = false
		}

		handleDisconnect() {
			if (this.disconnecting) return
			const wasConnected = this.connected
			this.rxCharacteristic?.removeEventListener(
				'characteristicvaluechanged',
				this.rxSubscription
			)
			this.connected = false
			this.server = null
			this.service = null
			this.rxCharacteristic = null
			this.txCharacteristic = null
			this.rxSubscription = null
			this.rxChain = Promise.resolve()
			if (wasConnected) this.disconnectHandler()
		}

		friendlyWriteError(error) {
			const name = error?.name || ''
			if (name === 'NetworkError') {
				return new Error(
					'BLE 写入失败。常见原因是"BLE 单包"超过了设备的 ATT MTU（单包上限 = MTU-3，透传模块常见为 244 字节），请在高级设置中调小后重试。'
				)
			}
			if (name === 'InvalidStateError') {
				return new Error(
					'BLE 写入失败，当前特征值不支持这种写入方式，请在高级设置中切换"写入方式"。'
				)
			}
			return this.friendlyError(error)
		}

		friendlyError(error) {
			const name = error?.name || ''
			if (name === 'NotFoundError') {
				return new Error('未找到该 BLE 设备或设备已离开范围')
			}
			if (name === 'SecurityError') {
				return new Error('蓝牙权限被拒绝，或页面不是 HTTPS/localhost 安全环境')
			}
			if (name === 'NetworkError') {
				return new Error('BLE 连接失败，设备可能已被其他程序占用')
			}
			if (name === 'NotSupportedError') {
				return new Error('设备不支持当前蓝牙串口服务')
			}
			if (name === 'InvalidStateError') {
				return new Error('蓝牙适配器未开启或连接状态异常')
			}
			return error instanceof Error ? error : new Error(String(error))
		}
	}

	window.BleSerialTransport = BleSerialTransport
})()
