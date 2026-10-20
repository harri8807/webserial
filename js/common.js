; (function () {
	let serialPort = null
	let transportMode =
		window.isSecureContext && localStorage.getItem('transportMode') === 'ble'
			? 'ble'
			: 'serial'
	let bleTransport = null
	let bleDevice = null
	let bleConnected = false
	let bleManualClose = true
	let bleReconnectTimer = null
	// 蓝牙模块是否加载成功: js/ble.js 缺失时不能让整个脚本抛 ReferenceError,
	// 否则串口、日志、快捷发送等所有功能都会一起失效。
	const bleModuleLoaded = typeof BleSerialTransport !== 'undefined'
	const bleSupported = bleModuleLoaded && BleSerialTransport.supported
	if (!('serial' in navigator)) {
		alert('当前浏览器不支持串口操作,请更换Edge或Chrome浏览器')
	} else {
		navigator.serial.getPorts().then((ports) => {
			if (ports.length > 0) {
				serialPort = ports[0]
				serialStatuChange(true)
			}
		})
	}
	let reader
	//串口目前是打开状态
	let serialOpen = false
	//串口目前是手动关闭状态
	let serialClose = true
	//串口循环发送时钟
	let serialloopSendTimer = null
	//串口缓存数据
	let serialData = []
	//串口分包合并时钟（蓝牙共用）
	let transportTimer = null
	//文本解码
	let textdecoder = new TextDecoder()
	let currQuickSend = []
	//快捷发送列表
	let quickSendList = [
		{
			name: 'ESP32 AT指令',
			list: [
				{
					name: '测试 AT 启动',
					content: 'AT',
					hex: false,
				},
				{
					name: '重启模块',
					content: 'AT+RST',
					hex: false,
				},
				{
					name: '查看版本信息',
					content: 'AT+GMR',
					hex: false,
				},
				{
					name: '查询当前固件支持的所有命令及命令类型',
					content: 'AT+CMD?',
					hex: false,
				},
				{
					name: '进⼊ Deep-sleep 模式 1分钟',
					content: 'AT+GSLP=60000',
					hex: false,
				},
				{
					name: '开启AT回显功能',
					content: 'ATE1',
					hex: false,
				},
				{
					name: '关闭AT回显功能',
					content: 'ATE0',
					hex: false,
				},
				{
					name: '恢复出厂设置',
					content: 'AT+RESTORE',
					hex: false,
				},
				{
					name: '查询 UART 当前临时配置',
					content: 'AT+UART_CUR?',
					hex: false,
				},
				{
					name: '设置 UART 115200 保存flash',
					content: 'AT+UART_DEF=115200,8,1,0,3',
					hex: false,
				},
				{
					name: '查询 sleep 模式',
					content: 'AT+SLEEP?',
					hex: false,
				},
				{
					name: '查询当前剩余堆空间和最小堆空间',
					content: 'AT+SYSRAM?',
					hex: false,
				},
				{
					name: '查询系统提示信息',
					content: 'AT+SYSMSG?',
					hex: false,
				},
				{
					name: '查询 flash 用户分区',
					content: 'AT+SYSFLASH?',
					hex: false,
				},
				{
					name: '查询本地时间戳',
					content: 'AT+SYSTIMESTAMP?',
					hex: false,
				},
				{
					name: '查询 AT 错误代码提示',
					content: 'AT+SYSLOG?',
					hex: false,
				},
				{
					name: '设置/查询系统参数存储模式',
					content: 'AT+SYSPARA?',
					hex: false,
				},
			],
		},
	]
	//工具配置
	let toolOptions = {
		//自动滚动
		autoScroll: true,
		//显示时间 界面未开放
		showTime: true,
		//日志类型
		logType: 'hex&text',
		//分包合并时间
		timeOut: 50,
		//末尾加回车换行
		addCRLF: false,
		//HEX发送
		hexSend: false,
		//循环发送
		loopSend: false,
		//循环发送时间
		loopSendTime: 1000,
		//输入的发送内容
		sendContent: '',
		//快捷发送选中索引
		quickSendIndex: 0,
		//主题设置
		darkTheme: false
	}

	// 从工程目录加载快捷发送配置
	async function loadQuickSendFromFile() {
		try {
			// 检查是否通过HTTP(S)协议访问
			if (window.location.protocol === 'file:') {
				console.log('检测到file://协议，无法自动加载配置文件')
				addLogErr('提示：请通过HTTP服务器访问页面以自动加载配置，或手动点击"从文件加载"')
				return false
			}
			
			const response = await fetch('./quicksend-config.json')
			if (response.ok) {
				const data = await response.json()
				if (Array.isArray(data) && data.length > 0) {
					quickSendList = data
					addLogErr('✓ 已从工程目录加载快捷发送配置 (KAFREE)')
					return true
				}
			} else {
				console.log('配置文件不存在或无法访问:', response.status)
				addLogErr('未找到 quicksend-config.json 文件，使用默认配置')
			}
		} catch (e) {
			console.log('加载工程目录配置失败:', e)
			if (e.name === 'TypeError' && e.message.includes('fetch')) {
				addLogErr('无法加载配置文件，请确保通过HTTP服务器访问或手动加载配置')
			}
		}
		return false
	}

	// 保存快捷发送配置到工程目录（仅在支持时）
	async function saveQuickSendToFile() {
		try {
			// 检查是否支持文件系统访问API
			if ('showSaveFilePicker' in window) {
				const fileHandle = await window.showSaveFilePicker({
					suggestedName: 'quicksend-config.json',
					types: [{
						description: '快捷发送配置文件',
						accept: { 'application/json': ['.json'] }
					}]
				})
				const writable = await fileHandle.createWritable()
				await writable.write(JSON.stringify(quickSendList, null, '\t'))
				await writable.close()
				return true
			}
		} catch (e) {
			// 用户取消操作不算错误
			if (e.name !== 'AbortError') {
				console.log('保存到文件失败:', e)
			}
		}
		return false
	}

	//生成快捷发送列表
	let quickSend = document.getElementById('serial-quick-send')
	
	// 先尝试从工程目录加载，如果失败则从localStorage加载
	let configLoaded = false
	
	// 初始化快捷发送列表
	async function initQuickSendList() {
		// 先尝试从工程目录加载
		configLoaded = await loadQuickSendFromFile()
		
		// 如果工程目录加载失败，从localStorage加载
		if (!configLoaded) {
			let sendList = localStorage.getItem('quickSendList')
			if (sendList) {
				try {
					quickSendList = JSON.parse(sendList)
					addLogErr('已从浏览器存储加载快捷发送配置')
				} catch (e) {
					console.log('localStorage数据解析失败:', e)
				}
			}
		}
		
		// 生成选项列表
		quickSend.innerHTML = ''
		quickSendList.forEach((item, index) => {
			let option = document.createElement('option')
			option.innerText = item.name
			option.value = index
			quickSend.appendChild(option)
		})
		
		// 触发默认选择
		if (quickSendList.length > 0) {
			quickSend.value = toolOptions.quickSendIndex || 0
			quickSend.dispatchEvent(new Event('change'))
		}
	}

	//快捷发送列表被单击
	document.getElementById('serial-quick-send-content').addEventListener('click', (e) => {
		let curr = e.target
		if (curr.tagName != 'BUTTON') {
			curr = curr.parentNode
		}
		if (curr.tagName != 'BUTTON') {
			return
		}
		const index = Array.from(curr.parentNode.parentNode.children).indexOf(curr.parentNode)
		if (curr.classList.contains('quick-remove')) {
			currQuickSend.list.splice(index, 1)
			curr.parentNode.remove()
			saveQuickList()
			return
		}
		if (curr.classList.contains('quick-send')) {
			let item = currQuickSend.list[index]
			if (item.hex) {
				sendHex(item.content)
				return
			}
			sendText(item.content)
		}
	})
	//快捷列表双击改名
	document.getElementById('serial-quick-send-content').addEventListener('dblclick', (e) => {
		let curr = e.target
		if (curr.tagName != 'INPUT' || curr.type != 'text') {
			return
		}
		const index = Array.from(curr.parentNode.parentNode.children).indexOf(curr.parentNode)
		changeName((name) => {
			currQuickSend.list[index].name = name
			curr.parentNode.outerHTML = getQuickItemHtml(currQuickSend.list[index])
			saveQuickList()
		}, currQuickSend.list[index].name)
	})
	//快捷发送列表被改变
	document.getElementById('serial-quick-send-content').addEventListener('change', (e) => {
		let curr = e.target
		if (curr.tagName != 'INPUT') {
			return
		}
		const index = Array.from(curr.parentNode.parentNode.children).indexOf(curr.parentNode)
		if (curr.type == 'text') {
			currQuickSend.list[index].content = curr.value
		}
		if (curr.type == 'checkbox') {
			currQuickSend.list[index].hex = curr.checked
		}
		saveQuickList()
	})
	function saveQuickList() {
		// 保存到localStorage作为备份
		localStorage.setItem('quickSendList', JSON.stringify(quickSendList))
		
		// 注意：由于浏览器安全限制，无法自动保存到工程目录
		// 只能通过用户手动操作来保存文件
		// 建议用户在修改配置后手动点击"保存到文件"按钮
	}

	const quickSendContent = document.getElementById('serial-quick-send-content')
	//快捷发送列表更换选项
	quickSend.addEventListener('change', (e) => {
		let index = e.target.value
		if (index != -1) {
			changeOption('quickSendIndex', index)
			currQuickSend = quickSendList[index]
			//
			quickSendContent.innerHTML = ''
			currQuickSend.list.forEach((item) => {
				quickSendContent.innerHTML += getQuickItemHtml(item)
			})
		}
	})
	//添加快捷发送
	document.getElementById('serial-quick-send-add').addEventListener('click', (e) => {
		const item = {
			name: '发送',
			content: '',
			hex: false,
		}
		currQuickSend.list.push(item)
		quickSendContent.innerHTML += getQuickItemHtml(item)
		saveQuickList()
	})
	function getQuickItemHtml(item) {
		return `<div class="d-flex p-1 border-bottom quick-item">
			<button type="button" title="移除该项" class="btn btn-sm btn-outline-secondary me-1 quick-remove"><i class="bi bi-x"></i></button>
			<input class="form-control form-control-sm me-1" placeholder="要发送的内容,双击改名" value="${item.content}">
			<button class="flex-shrink-0 me-1 align-self-center btn btn-secondary btn-sm  quick-send" title="${item.name}">${item.name}</button>
			<input class="form-check-input flex-shrink-0 align-self-center" type="checkbox" ${item.hex ? 'checked' : ''}>
		</div>`
	}
	//快捷发送分组新增
	document.getElementById('serial-quick-send-add-group').addEventListener('click', (e) => {
		changeName((name) => {
			quickSendList.push({
				name: name,
				list: [],
			})
			quickSend.innerHTML += `<option value="${quickSendList.length - 1}">${name}</option>`
			quickSend.value = quickSendList.length - 1
			quickSend.dispatchEvent(new Event('change'))
			saveQuickList()
		})
	})
	//快捷发送分组重命名
	document.getElementById('serial-quick-send-rename-group').addEventListener('click', (e) => {
		changeName((name) => {
			currQuickSend.name = name
			quickSend.options[quickSend.value].innerText = name
			saveQuickList()
		}, currQuickSend.name)
	})
	//快捷发送分组删除
	document.getElementById('serial-quick-send-remove-group').addEventListener('click', (e) => {
		if (quickSendList.length == 1) {
			return
		}
		//弹窗询问是否删除
		if (!confirm('是否删除该分组?')) {
			return
		}
		quickSendList.splice(quickSend.value, 1)
		quickSend.options[quickSend.value].remove()
		quickSend.value = 0
		quickSend.dispatchEvent(new Event('change'))
		saveQuickList()
	})

	//导出
	document.getElementById('serial-quick-send-export').addEventListener('click', (e) => {
		let data = JSON.stringify(currQuickSend.list)
		let blob = new Blob([data], { type: 'text/plain' })
		saveAs(blob, currQuickSend.name + '.json')
	})
	//导入
	document.getElementById('serial-quick-send-import-btn').addEventListener('click', (e) => {
		document.getElementById('serial-quick-send-import').click()
	})
	document.getElementById('serial-quick-send-import').addEventListener('change', (e) => {
		let file = e.target.files[0]
		e.target.value = ''
		let reader = new FileReader()
		reader.onload = function (e) {
			let data = e.target.result
			try {
				let list = JSON.parse(data)
				currQuickSend.list.push(...list)
				list.forEach((item) => {
					quickSendContent.innerHTML += getQuickItemHtml(item)
				})
				saveQuickList()
			} catch (e) {
				showMsg('导入失败:' + e.message)
			}
		}
		reader.readAsText(file)
	})

	//读取参数
	let options = localStorage.getItem('serialOptions')
	if (options) {
		let serialOptions = JSON.parse(options)
		set('serial-baud', serialOptions.baudRate)
		set('serial-data-bits', serialOptions.dataBits)
		set('serial-stop-bits', serialOptions.stopBits)
		set('serial-parity', serialOptions.parity)
	}
	options = localStorage.getItem('toolOptions')
	if (options) {
		toolOptions = JSON.parse(options)
	}
	document.getElementById('serial-timer-out').value = toolOptions.timeOut
	document.getElementById('serial-log-type').value = toolOptions.logType
	document.getElementById('serial-auto-scroll').innerText = toolOptions.autoScroll ? '自动滚动' : '暂停滚动'
	document.getElementById('serial-add-crlf').checked = toolOptions.addCRLF
	document.getElementById('serial-hex-send').checked = toolOptions.hexSend
	document.getElementById('serial-loop-send').checked = toolOptions.loopSend
	document.getElementById('serial-loop-send-time').value = toolOptions.loopSendTime
	document.getElementById('serial-send-content').value = toolOptions.sendContent
	document.getElementById('ble-chunk-size').value = toolOptions.bleChunkSize || 244
	document.getElementById('ble-write-delay').value =
		toolOptions.bleWriteDelay === undefined ? 8 : toolOptions.bleWriteDelay
	document.getElementById('ble-write-mode').value = toolOptions.bleWriteMode || 'auto'
	document.getElementById('ble-name-prefix').value = toolOptions.bleNamePrefix || ''
	// 旧版页面没有"设备过滤"下拉框时保持原行为(显示全部设备)
	set('ble-filter-mode', toolOptions.bleFilterMode === 'all' ? 'all' : 'supported')
	updateBleFilterHint()
	resetLoopSend()
	
	// 初始化快捷发送列表
	initQuickSendList()
	initTransportMode()

	//实时修改选项
	document.getElementById('serial-timer-out').addEventListener('change', (e) => {
		changeOption('timeOut', parseInt(e.target.value))
	})
	document.getElementById('serial-log-type').addEventListener('change', (e) => {
		changeOption('logType', e.target.value)
		if (e.target.value.includes('ansi')) {
			serialLogs.classList.add('ansi')
		} else {
			serialLogs.classList.remove('ansi')
		}
	})
	document.getElementById('serial-auto-scroll').addEventListener('click', function (e) {
		let autoScroll = this.innerText != '自动滚动'
		this.innerText = autoScroll ? '自动滚动' : '暂停滚动'
		changeOption('autoScroll', autoScroll)
	})
	document.getElementById('serial-send-content').addEventListener('change', function (e) {
		changeOption('sendContent', this.value)
	})
	// Ctrl+Enter 快捷键发送
	document.getElementById('serial-send-content').addEventListener('keydown', function (e) {
		if (e.ctrlKey && e.key === 'Enter') {
			e.preventDefault()
			send()
		}
	})
	document.getElementById('serial-add-crlf').addEventListener('change', function (e) {
		changeOption('addCRLF', this.checked)
	})
	document.getElementById('serial-hex-send').addEventListener('change', function (e) {
		changeOption('hexSend', this.checked)
	})
	document.getElementById('serial-loop-send').addEventListener('change', function (e) {
		changeOption('loopSend', this.checked)
		resetLoopSend()
	})
	document.getElementById('serial-loop-send-time').addEventListener('change', function (e) {
		changeOption('loopSendTime', parseInt(this.value))
		resetLoopSend()
	})
	document.getElementById('ble-chunk-size').addEventListener('change', function (e) {
		const size = Math.max(1, Math.min(512, parseInt(this.value, 10) || 244))
		this.value = size
		changeOption('bleChunkSize', size)
		// 立即生效, 不用重连
		bleTransport?.setChunkSize?.(size)
	})
	document.getElementById('ble-write-delay').addEventListener('change', function (e) {
		changeOption('bleWriteDelay', Math.max(0, Math.min(200, parseInt(this.value, 10) || 0)))
	})
	document.getElementById('ble-write-mode').addEventListener('change', function (e) {
		changeOption('bleWriteMode', this.value)
	})
	document.getElementById('ble-name-prefix').addEventListener('change', function (e) {
		changeOption('bleNamePrefix', this.value.trim())
	})
	document.getElementById('ble-filter-mode')?.addEventListener('change', function (e) {
		changeOption('bleFilterMode', this.value)
		updateBleFilterHint()
	})
	document.getElementById('ble-profile').addEventListener('change', function (e) {
		changeOption('bleProfile', this.value)
		const isCustom = this.value === 'custom'
		document
			.getElementById('ble-custom-uuids')
			.classList.toggle('d-none', !isCustom)
		// 选自定义时自动展开高级设置, 否则填写的 UUID 被折叠挡住
		if (isCustom) {
			document.querySelector('.ble-advanced')?.setAttribute('open', '')
		}
	})
	;['ble-service-uuid', 'ble-rx-uuid', 'ble-tx-uuid'].forEach((id) => {
		document.getElementById(id).addEventListener('change', function () {
			const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
			changeOption(key, this.value.trim())
		})
	})

	document.querySelectorAll('#serial-options .input-group input,#serial-options .input-group select').forEach((item) => {
		item.addEventListener('change', async (e) => {
			if (item.closest('#ble-config')) return
			if (transportMode !== 'serial') return
			if (!serialOpen) {
				return
			}
			//未找到API可以动态修改串口参数,先关闭再重新打开
			await closeSerial()
			//立即打开会提示串口已打开,延迟50ms再打开
			setTimeout(() => {
				openSerial()
			}, 50)
		})
	})

	//重制发送循环时钟
	function resetLoopSend() {
		clearInterval(serialloopSendTimer)
		if (toolOptions.loopSend) {
			serialloopSendTimer = setInterval(() => {
				send()
			}, toolOptions.loopSendTime)
		}
	}

	//清空
	document.getElementById('serial-clear').addEventListener('click', (e) => {
		serialLogs.innerHTML = ''
	})
	//复制
	document.getElementById('serial-copy').addEventListener('click', (e) => {
		let text = serialLogs.innerText
		if (text) {
			copyText(text)
		}
	})
	//保存
	document.getElementById('serial-save').addEventListener('click', (e) => {
		let text = serialLogs.innerText
		if (text) {
			saveText(text)
		}
	})
	//发送
	document.getElementById('serial-send').addEventListener('click', (e) => {
		send()
	})

	const serialToggle = document.getElementById('serial-open-or-close')
	const serialLogs = document.getElementById('serial-logs')
	const bleSearch = document.getElementById('ble-search')
	const bleToggle = document.getElementById('ble-open-or-close')

	//选择串口
	document.getElementById('serial-select-port').addEventListener('click', async () => {
		if (transportMode !== 'serial') return
		// 客户端授权
		try {
			await navigator.serial.requestPort().then(async (port) => {
				closeSerial()
				serialPort = port
				serialStatuChange(true)
			})
		} catch (e) {
			console.error('获取串口权限出错' + e.toString())
		}
	})

	//关闭串口
	async function closeSerial() {
		if (serialOpen) {
			serialOpen = false
			reader?.cancel()
			serialToggle.innerHTML = '打开串口'
		}
	}

	//切换串口 / 蓝牙
	function initTransportMode() {
		if (!bleSupported) {
			document.querySelectorAll('[data-transport="ble"]').forEach((button) => {
				button.disabled = true
				button.title = bleModuleLoaded
					? '当前浏览器不支持 Web Bluetooth'
					: '蓝牙模块 js/ble.js 未加载，请检查部署文件是否完整'
			})
		}
		if (transportMode === 'ble' && (!bleSupported || !window.isSecureContext)) {
			transportMode = 'serial'
			localStorage.setItem('transportMode', 'serial')
		}
		const profile = toolOptions.bleProfile || 'auto'
		document.getElementById('ble-profile').value = profile
		document
			.getElementById('ble-custom-uuids')
			.classList.toggle('d-none', profile !== 'custom')
		if (profile === 'custom') {
			// 展开高级设置，否则填写的 UUID 被折叠挡住看不见
			document.querySelector('.ble-advanced')?.setAttribute('open', '')
		}
		document.getElementById('ble-service-uuid').value = toolOptions.bleServiceUuid || ''
		document.getElementById('ble-rx-uuid').value = toolOptions.bleRxUuid || ''
		document.getElementById('ble-tx-uuid').value = toolOptions.bleTxUuid || ''

		document.querySelectorAll('[data-transport]').forEach((button) => {
			button.classList.toggle('active', button.dataset.transport === transportMode)
			button.addEventListener('click', () => {
				setTransportMode(button.dataset.transport).catch((error) => {
					console.error('切换连接方式失败', error)
				})
			})
		})
		applyTransportMode()
	}

	async function setTransportMode(mode) {
		if (mode === transportMode) return
		if (mode === 'ble') {
			if (!bleSupported) {
				showMsg(
					bleModuleLoaded
						? '当前浏览器不支持 Web Bluetooth。请使用最新版 Chrome / Edge，并通过 HTTPS 或 localhost 打开页面。'
						: '蓝牙模块 js/ble.js 未加载，请检查部署文件是否完整。'
				)
				return
			}
			if (!window.isSecureContext) {
				showMsg(
					'蓝牙需要 HTTPS 或 localhost 安全环境。请使用 start-server.bat 启动本地服务器后访问 http://localhost:8000。'
				)
				return
			}
			await closeSerial()
			serialClose = true
		} else {
			await disconnectBle(true)
		}
		transportMode = mode
		localStorage.setItem('transportMode', mode)
		document.querySelectorAll('[data-transport]').forEach((button) => {
			button.classList.toggle('active', button.dataset.transport === mode)
		})
		applyTransportMode()
	}

	function applyTransportMode() {
		const isBle = transportMode === 'ble'
		document.getElementById('serial-config').classList.toggle('d-none', isBle)
		document.getElementById('ble-config').classList.toggle('d-none', !isBle)
		document.getElementById('log-title').innerText = isBle ? '蓝牙日志' : '串口日志'
		document.getElementById('serial-send-content').placeholder = isBle
			? '输入要发送到蓝牙设备的内容，支持文本或 HEX'
			: '在此输入要发送的内容,可以是字符串(如:你好,世界!),也可以是HEX(如:49544c4447)'
	}

	function setBleStatus(type, message) {
		document.getElementById('ble-status').innerHTML =
			`<div class="alert alert-${type} py-2" role="alert">${HTMLEncode(message)}</div>`
	}

	function updateBleDeviceCard(device) {
		if (!device) {
			document.getElementById('ble-device-name').innerText = '尚未搜索设备'
			document.getElementById('ble-device-id').innerText = '点击下方按钮搜索附近的 BLE 设备'
			return
		}
		document.getElementById('ble-device-name').innerText = device.name || '未命名 BLE 设备'
		document.getElementById('ble-device-id').innerText = device.id || ''
	}

	function bleOptions() {
		return {
			profile: document.getElementById('ble-profile').value,
			namePrefix: document.getElementById('ble-name-prefix').value,
			filterMode: get('ble-filter-mode') || 'all',
			chunkSize: parseInt(document.getElementById('ble-chunk-size').value, 10) || 244,
			writeMode: document.getElementById('ble-write-mode').value,
			writeDelay: parseInt(document.getElementById('ble-write-delay').value, 10) || 0,
			serviceUuid: document.getElementById('ble-service-uuid').value,
			rxUuid: document.getElementById('ble-rx-uuid').value,
			txUuid: document.getElementById('ble-tx-uuid').value,
		}
	}

	// 扫描过滤的提示文案: 让用户知道当前会不会把未知/不支持的设备过滤掉。
	function updateBleFilterHint() {
		const el = document.getElementById('ble-filter-hint')
		if (!el) return
		const mode = get('ble-filter-mode') || 'all'
		el.innerText =
			mode === 'all'
				? '当前显示全部设备，未知设备和不支持的设备也会出现。填写“名称前缀”可以只看名称匹配的设备。'
				: '仅显示广播中带已知串口服务 UUID 的设备，未知设备与耳机、手环等不支持的设备不会出现。若模块不广播服务 UUID 会搜不到，可切换为“全部设备”并填写名称前缀。'
	}

	// 单包写入失败时, 传输层会自动降级, 这里同步更新界面和提示。
	function handleBlePacketSizeChange(limit) {
		document.getElementById('ble-chunk-size').value = limit
		changeOption('bleChunkSize', limit)
		setBleStatus(
			'warning',
			`单包写入失败，已自动降级为 ${limit} 字节（设备协商的 MTU 可能更小）`
		)
		addLogErr(`BLE 单包自动降级为 ${limit} 字节`)
	}

	bleSearch.addEventListener('click', async () => {
		if (!bleSupported) {
			setBleStatus(
				'danger',
				bleModuleLoaded
					? '当前浏览器不支持 Web Bluetooth，请使用最新版 Chrome 或 Edge'
					: '蓝牙模块 js/ble.js 未加载，请检查部署文件是否完整'
			)
			return
		}
		bleSearch.disabled = true
		try {
			if (bleConnected || bleTransport) await disconnectBle(true)
			clearTimeout(bleReconnectTimer)
			bleTransport = new BleSerialTransport({
				onDisconnect: handleBleDisconnected,
				onPacketSizeChange: handleBlePacketSizeChange,
			})
			bleDevice = await bleTransport.requestDevice(bleOptions())
			// 必须用闭包转发: dataReceived 是函数声明, OTA 流程里会重新赋值
			// 这个变量来监听 'C' 字符。如果直接传函数对象, 蓝牙侧拿到的仍是
			// 原始函数, OTA 会一直等不到 'C' 直到超时。
			bleTransport.onData = (data) => dataReceived(data)
			bleTransport.onError = (error) => {
				addLogErr('蓝牙数据处理出错：' + (error?.message || error))
			}
			bleTransport.setDisconnectHandler(handleBleDisconnected)
			bleManualClose = true
			updateBleDeviceCard(bleDevice)
			setBleStatus('success', '已选择设备，点击“连接蓝牙”建立串口通道')
			bleToggle.innerText = '连接蓝牙'
		} catch (error) {
			if (error?.name === 'AbortError') {
				setBleStatus('info', '已取消设备搜索')
				return
			}
			if (error?.name === 'NotFoundError') {
				setBleStatus(
					'info',
					'未选择设备，或附近没有匹配的 BLE 设备。若设备明明在旁边却搜不到，请把高级设置里的"设备过滤"切换为"全部设备"后重试。'
				)
			} else if (error?.name === 'SecurityError') {
				setBleStatus('danger', '蓝牙权限被拒绝，请检查浏览器权限和 HTTPS 环境')
			} else {
				setBleStatus('danger', '搜索设备失败：' + (error?.message || error))
			}
		} finally {
			bleSearch.disabled = false
		}
	})

	bleToggle.addEventListener('click', async () => {
		if (bleConnected) {
			await disconnectBle(true)
			return
		}
		if (!bleTransport || !bleDevice) {
			setBleStatus('info', '请先点击“搜索设备”选择 BLE 设备')
			return
		}
		bleToggle.disabled = true
		setBleStatus('info', '正在连接 BLE 设备...')
		try {
			bleTransport.onData = (data) => dataReceived(data)
			bleTransport.onError = (error) => {
				addLogErr('蓝牙数据处理出错：' + (error?.message || error))
			}
			await bleTransport.connect({
				...bleOptions(),
				onDisconnect: handleBleDisconnected,
			})
			bleConnected = true
			bleManualClose = false
			clearTimeout(bleReconnectTimer)
			bleToggle.innerText = '断开蓝牙'
			setBleStatus(
				'success',
				`已连接 · ${bleTransport.profile?.name || 'BLE 串口'} · 单包 ${
					bleTransport.packetSize || bleTransport.chunkSize
				} 字节`
			)
			addLogErr('蓝牙连接成功')
		} catch (error) {
			bleConnected = false
			bleToggle.innerText = '连接蓝牙'
			setBleStatus('danger', error?.message || String(error))
			addLogErr('蓝牙连接失败：' + (error?.message || error))
		} finally {
			bleToggle.disabled = false
		}
	})

	document.getElementById('ble-forget').addEventListener('click', async () => {
		if (bleConnected) await disconnectBle(true)
		try {
			if (bleDevice?.forget) {
				await bleDevice.forget()
			} else {
				showMsg('当前浏览器版本不支持清除单个蓝牙授权，请在浏览器站点设置中移除蓝牙权限。')
				return
			}
			bleTransport = null
			bleDevice = null
			updateBleDeviceCard(null)
			setBleStatus('info', '已清除蓝牙授权记录，可重新搜索设备')
		} catch (error) {
			setBleStatus('danger', '清除授权失败：' + (error?.message || error))
		}
	})

	async function disconnectBle(manual = false) {
		if (manual) bleManualClose = true
		clearTimeout(bleReconnectTimer)
		bleTransport?.setDisconnectHandler?.(() => {})
		if (!bleTransport) {
			bleConnected = false
			bleToggle.innerText = '连接蓝牙'
			return
		}
		try {
			await bleTransport.disconnect()
		} catch (_) {}
		bleConnected = false
		bleToggle.innerText = '连接蓝牙'
		if (manual) {
			setBleStatus('info', '蓝牙已断开')
			addLogErr('蓝牙已断开')
		}
	}

	function handleBleDisconnected() {
		bleConnected = false
		bleToggle.innerText = '连接蓝牙'
		if (bleManualClose) return
		setBleStatus('danger', '蓝牙连接意外断开，正在尝试重连...')
		addLogErr('蓝牙连接意外断开')
		clearTimeout(bleReconnectTimer)
		bleReconnectTimer = setTimeout(async () => {
			if (bleManualClose || transportMode !== 'ble' || !bleTransport) return
			try {
				// 重连后要重新绑定一次: connect() 会重置 rx 队列,
				// onData 必须继续用闭包转发, 否则 OTA 覆盖后的 dataReceived 收不到。
				bleTransport.onData = (data) => dataReceived(data)
				await bleTransport.connect({
					...bleOptions(),
					onDisconnect: handleBleDisconnected,
				})
				bleConnected = true
				bleToggle.innerText = '断开蓝牙'
				setBleStatus('success', '蓝牙已自动重连')
				addLogErr('蓝牙已自动重连')
			} catch (error) {
				bleConnected = false
				setBleStatus('danger', '蓝牙重连失败，请重新搜索设备')
				addLogErr('蓝牙重连失败：' + (error?.message || error))
			}
		}, 1200)
	}

	//打开串口
	async function openSerial() {
		let SerialOptions = {
			baudRate: parseInt(get('serial-baud')),
			dataBits: parseInt(get('serial-data-bits')),
			stopBits: parseInt(get('serial-stop-bits')),
			parity: get('serial-parity'),
		}
		// console.log('串口配置', JSON.stringify(SerialOptions))
		serialPort
			.open(SerialOptions)
			.then(() => {
				serialToggle.innerHTML = '关闭串口'
				serialOpen = true
				serialClose = false
				localStorage.setItem('serialOptions', JSON.stringify(SerialOptions))
				readData()
			})
			.catch((e) => {
				showMsg('打开串口失败:' + e.toString())
			})
	}

	//打开或关闭串口
	serialToggle.addEventListener('click', async () => {
		if (!serialPort) {
			showMsg('请先选择串口')
			return
		}

		if (serialPort.writable && serialPort.readable) {
			closeSerial()
			serialClose = true
			return
		}

		openSerial()
	})

	//设置读取元素
	function get(id) {
		const el = document.getElementById(id)
		return el ? el.value : ''
	}
	function set(id, value) {
		const el = document.getElementById(id)
		if (el) el.value = value
	}

	//修改参数并保存
	function changeOption(key, value) {
		toolOptions[key] = value
		localStorage.setItem('toolOptions', JSON.stringify(toolOptions))
	}

	//串口事件监听
	if ('serial' in navigator) {
		navigator.serial.addEventListener('connect', (e) => {
			serialStatuChange(true)
			serialPort = e.target
			//未主动关闭连接的情况下,设备重插,自动重连
			if (!serialClose) {
				openSerial()
			}
		})
		navigator.serial.addEventListener('disconnect', (e) => {
			serialStatuChange(false)
			setTimeout(closeSerial, 500)
		})
	}
	function serialStatuChange(statu) {
		let tip
		if (statu) {
			tip = '<div class="alert alert-success" role="alert">设备已连接</div>'
		} else {
			tip = '<div class="alert alert-danger" role="alert">设备已断开</div>'
		}
		document.getElementById('serial-status').innerHTML = tip
	}
	//串口数据收发
	async function send() {
		let content = document.getElementById('serial-send-content').value
		if (!content) {
			addLogErr('发送内容为空')
			return
		}
		if (toolOptions.hexSend) {
			await sendHex(content)
		} else {
			if (toolOptions.addCRLF) {
				content += '\r\n'
			}
			await sendText(content)
		}
	}

	//发送HEX到串口
	async function sendHex(hex) {
		const value = hex.replace(/\s+/g, '')
		if (/^[0-9A-Fa-f]+$/.test(value) && value.length % 2 === 0) {
			let data = []
			for (let i = 0; i < value.length; i = i + 2) {
				data.push(parseInt(value.substring(i, i + 2), 16))
			}
			await writeData(Uint8Array.from(data))
		} else {
			addLogErr('HEX格式错误:' + hex)
		}
	}

	//发送文本到串口
	async function sendText(text) {
		const encoder = new TextEncoder()
		// 蓝牙写入是异步分片的, 必须等待完成, 否则循环发送/OTA 会交错
		await writeData(encoder.encode(text))
	}

	//串口写数据
	async function writeData(data, skipLog = false) {
		if (transportMode === 'ble') {
			if (!bleConnected || !bleTransport) {
				addLogErr('蓝牙未连接，无法发送')
				return
			}
			try {
				const payload = data instanceof Uint8Array ? data : Uint8Array.from(data)
				await bleTransport.write(payload)
				if (!skipLog) addLog(Array.from(data), false)
			} catch (e) {
				addLogErr('蓝牙写入失败: ' + (e?.message || e))
			}
			return
		}

		if (serialPort == null || serialPort.writable == null) {
			return
		}

		try {
			const writer = serialPort.writable.getWriter()
			await writer.write(data)
			writer.releaseLock() // 释放写入锁
			
			// 只有当不跳过日志时才记录发送数据
			if (!skipLog) {
				addLog(Array.from(data), false)
			}
			
		} catch (e) {
			console.log('写入失败', e)
			addLogErr('写入失败: ' + e)
		}
	}

	//读串口数据
	async function readData() {
		while (serialOpen && serialPort.readable) {
			reader = serialPort.readable.getReader()
			try {
				while (true) {
					const { value, done } = await reader.read()
					if (done) {
						break
					}
					await dataReceived(value)
				}
			} catch (error) {
			} finally {
				reader.releaseLock()
			}
		}
		await serialPort.close()
	}

	// 固件升级相关变量
	let firmwareUpgrading = false;
	let ymodem = null; // 添加全局YModem实例变量
	const firmwareFile = document.getElementById('firmware-file');
	const uploadFirmware = document.getElementById('upload-firmware');
	const progressBar = document.querySelector('.firmware-upgrade .progress');
	const progressBarInner = progressBar.querySelector('.progress-bar');
	const firmwareStatus = document.getElementById('firmware-status');

	// 固件升级按钮点击事件
	uploadFirmware.addEventListener('click', async () => {
		if (transportMode === 'ble' ? !bleConnected : !serialPort || !serialPort.writable) {
			showMsg(transportMode === 'ble' ? '请先连接蓝牙' : '请先打开串口');
			return;
		}

		const file = firmwareFile.files[0];
		if (!file) {
			showMsg('请先选择固件文件');
			return;
		}

		if (firmwareUpgrading) {
			showMsg('固件升级正在进行中...');
			return;
		}

		try {
			firmwareUpgrading = true;
			progressBar.style.display = 'flex';
			progressBarInner.style.width = '0%';
			progressBarInner.textContent = '0%';
			firmwareStatus.style.display = 'block';
			firmwareStatus.className = 'alert alert-info';
			uploadFirmware.disabled = true;
			firmwareFile.disabled = true;

			// 发送进入升级模式的命令
			firmwareStatus.textContent = '发送进入升级模式命令...';
			const enterOtaCmd = new TextEncoder().encode('123@OTA@NULL#123');
			await writeData(enterOtaCmd);

			firmwareStatus.textContent = '等待设备响应C字符(10秒超时)...';
			addLogErr('等待设备返回C字符进入升级模式...');
			
			// 等待设备返回'C'字符，超时时间10秒
			let receivedC = false;
			let deviceResponseTimeout = null;
			const originalDataReceived = dataReceived; // 保存原始数据接收函数
			
			// 创建等待C字符的Promise
			try {
				await new Promise((resolve, reject) => {
					// 设置接收C字符的处理函数
					dataReceived = async function(data) {
						// 记录接收到的数据（调试用）
						const dataHex = Array.from(data).map(b => ('0' + b.toString(16).toUpperCase()).slice(-2)).join(' ');
						console.log(`[OTA] 接收数据: ${dataHex}`);
						
						// 检查是否包含'C'字符
						for (const byte of data) {
							if (byte === 67) { // 'C'的ASCII码是67
								receivedC = true;
								firmwareStatus.textContent = 'C字符已接收，开始传输...';
								addLogErr('接收到C字符，开始YMODEM传输');
								clearTimeout(deviceResponseTimeout);
								resolve();
								return;
							}
						}
						
						// 处理其他数据
						await originalDataReceived(data);
					};
					
					// 设置10秒超时
					deviceResponseTimeout = setTimeout(() => {
						addLogErr('等待C字符超时(10秒)');
						reject(new Error('等待设备响应超时，未收到C字符'));
					}, 10000);
				});
				
				// 初始化YModem实例
				ymodem = new YModem();
				// 启用1K模式
				ymodem.use1K = true;
				ymodem.logLevel = 'debug'; // 设置日志级别为debug，方便调试

				// 启动YMODEM
				await ymodem.start(
					file,
					// 发送数据回调
					async (dataToSend) => {
						await writeData(dataToSend, true); // 添加第二个参数表示升级数据，不记录日志
					},
					// 进度回调
					(progress) => {
						progressBarInner.style.width = `${progress}%`;
						progressBarInner.textContent = `${progress}%`;
						firmwareStatus.textContent = `传输中：${progress}%`;
					},
					// 成功回调
					() => {
						firmwareStatus.textContent = '固件升级成功！';
						firmwareStatus.className = 'alert alert-success';
						addLogErr('固件升级完成');
						resetFirmwareUpgrade();
					},
					// 错误回调
					(error) => {
						firmwareStatus.textContent = `升级失败：${error}`;
						firmwareStatus.className = 'alert alert-danger';
						addLogErr(`升级失败：${error}`);
						resetFirmwareUpgrade();
					}
				);
			} catch (error) {
				firmwareStatus.textContent = `升级失败：${error.message}`;
				firmwareStatus.className = 'alert alert-danger';
				addLogErr(`升级失败：${error.message}`);
				resetFirmwareUpgrade();
			} finally {
				// 恢复原始数据接收函数
				dataReceived = originalDataReceived;
			}
		} catch (error) {
			firmwareStatus.textContent = `升级失败：${error.message}`;
			firmwareStatus.className = 'alert alert-danger';
			addLogErr(`升级失败：${error.message}`);
			resetFirmwareUpgrade();
		}
	});

	// 重置固件升级状态
	function resetFirmwareUpgrade() {
		firmwareUpgrading = false;
		uploadFirmware.disabled = false;
		firmwareFile.disabled = false;
		ymodem = null;
	}

	// 修改数据接收处理函数
	async function dataReceived(data) {
		// 如果在固件升级状态且YMODEM实例存在且未完成/出错
		if (firmwareUpgrading && ymodem &&
			ymodem.state !== 'DONE' && ymodem.state !== 'ERROR') {

			// 逐字节处理YMODEM协议数据
			for (let i = 0; i < data.length; i++) {
				await ymodem.handleByte(data[i]);
				// 如果完成或出错，停止处理剩余字节
				if (ymodem.state === 'DONE' || ymodem.state === 'ERROR') {
					break;
				}
			}
		}

		// 常规数据处理（非升级状态或已完成/出错）
		if (!firmwareUpgrading || !ymodem ||
			ymodem.state === 'DONE' || ymodem.state === 'ERROR') {

			serialData.push(...data);
			if (toolOptions.timeOut == 0) {
				addLog(serialData, true);
				serialData = [];
				return;
			}

			//清除之前的时钟
			clearTimeout(transportTimer);
			transportTimer = setTimeout(() => {
				//超时发出
				addLog(serialData, true);
				serialData = [];
			}, toolOptions.timeOut);
		}
	}

	var ansi_up = new AnsiUp()
	//添加日志
	function addLog(data, isReceive = true) {
		let classname = 'text-primary'
		let form = '→'
		if (isReceive) {
			classname = 'text-success'
			form = '←'
		}
		newmsg = ''
		if (toolOptions.logType.includes('hex')) {
			let dataHex = []
			for (const d of data) {
				//转16进制并补0
				dataHex.push(('0' + d.toString(16).toLocaleUpperCase()).slice(-2))
			}
			if (toolOptions.logType.includes('&')) {
				newmsg += 'HEX:'
			}
			newmsg += dataHex.join(' ') + '<br/>'
		}
		if (toolOptions.logType.includes('text')) {
			let dataText = textdecoder.decode(Uint8Array.from(data))
			if (toolOptions.logType.includes('&')) {
				newmsg += 'TEXT:'
			}
			//转义HTML标签,防止内容被当作标签渲染
			newmsg += HTMLEncode(dataText)
		}
		if (toolOptions.logType.includes('ansi')) {
			const dataText = textdecoder.decode(Uint8Array.from(data))
			const html = ansi_up.ansi_to_html(dataText)
			newmsg += html
		}
		let time = toolOptions.showTime ? formatDate(new Date()) + '&nbsp;' : ''
		const template = '<div><span class="' + classname + '">' + time + form + '</span><br>' + newmsg + '</div>'
		let tempNode = document.createElement('div')
		tempNode.innerHTML = template
		serialLogs.append(tempNode)
		if (toolOptions.autoScroll) {
			serialLogs.scrollTop = serialLogs.scrollHeight - serialLogs.clientHeight
		}
	}
	//HTML转义
	function HTMLEncode(html) {
		var temp = document.createElement('div')
		temp.textContent != null ? (temp.textContent = html) : (temp.innerText = html)
		var output = temp.innerHTML
		temp = null
		return output
	}
	//HTML反转义
	function HTMLDecode(text) {
		var temp = document.createElement('div')
		temp.innerHTML = text
		var output = temp.innerText || temp.textContent
		temp = null
		return output
	}
	//系统日志
	function addLogErr(msg) {
		let time = toolOptions.showTime ? formatDate(new Date()) + '&nbsp;' : ''
		const template = '<div><span class="text-danger">' + time + ' 系统消息</span><br>' + msg + '</div>'
		let tempNode = document.createElement('div')
		tempNode.innerHTML = template
		serialLogs.append(tempNode)
		if (toolOptions.autoScroll) {
			serialLogs.scrollTop = serialLogs.scrollHeight - serialLogs.clientHeight
		}
	}

	//复制文本
	function copyText(text) {
		let textarea = document.createElement('textarea')
		textarea.value = text
		textarea.readOnly = 'readonly'
		textarea.style.position = 'absolute'
		textarea.style.left = '-9999px'
		document.body.appendChild(textarea)
		textarea.select()
		textarea.setSelectionRange(0, textarea.value.length)
		document.execCommand('copy')
		document.body.removeChild(textarea)
		showMsg('已复制到剪贴板')
	}

	//保存文本
	function saveText(text) {
		let blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
		saveAs(blob, 'serial.log')
	}

	//下载文件
	function saveAs(blob, filename) {
		if (window.navigator.msSaveOrOpenBlob) {
			navigator.msSaveBlob(blob, filename)
		} else {
			let link = document.createElement('a')
			let body = document.querySelector('body	')
			link.href = window.URL.createObjectURL(blob)
			link.download = filename
			// fix Firefox
			link.style.display = 'none'
			body.appendChild(link)
			link.click()
			body.removeChild(link)
			window.URL.revokeObjectURL(link.href)
		}
	}

	//弹窗
	const modalTip = new bootstrap.Modal('#model-tip')
	function showMsg(msg, title = 'Web Serial') {
		//alert(msg)
		document.getElementById('modal-title').innerHTML = title
		document.getElementById('modal-message').innerHTML = msg
		modalTip.show()
	}

	//当前时间 精确到毫秒
	function formatDate(now) {
		const hour = now.getHours() < 10 ? '0' + now.getHours() : now.getHours()
		const minute = now.getMinutes() < 10 ? '0' + now.getMinutes() : now.getMinutes()
		const second = now.getSeconds() < 10 ? '0' + now.getSeconds() : now.getSeconds()
		const millisecond = ('00' + now.getMilliseconds()).slice(-3)
		return `${hour}:${minute}:${second}.${millisecond}`
	}

	//左右折叠
	document.querySelectorAll('.toggle-button').forEach((element) => {
		element.addEventListener('click', (e) => {
			e.currentTarget.parentElement.querySelector('.collapse').classList.toggle('show')
			e.currentTarget.querySelector('i').classList.toggle('bi-chevron-compact-right')
			e.currentTarget.querySelector('i').classList.toggle('bi-chevron-compact-left')
		})
	})

	//设置名称
	const modalNewName = new bootstrap.Modal('#model-change-name')
	function changeName(callback, oldName = '') {
		set('model-new-name', oldName)
		modalNewName.show()
		document.getElementById('model-save-name').onclick = null
		document.getElementById('model-save-name').onclick = function () {
			callback(get('model-new-name'))
			modalNewName.hide()
		}
	}

	// 主题切换功能
	const themeToggleBtn = document.getElementById('theme-toggle');
	const themeIcon = themeToggleBtn ? themeToggleBtn.querySelector('i') : null;

	function updateTheme(isDark) {
		document.documentElement.setAttribute('data-bs-theme', isDark ? 'dark' : 'light');
		if (themeIcon) {
			themeIcon.className = isDark ? 'bi bi-sun-fill' : 'bi bi-moon-fill';
		}
		toolOptions.darkTheme = isDark;
		localStorage.setItem('toolOptions', JSON.stringify(toolOptions));
	}

	if (themeToggleBtn) {
		themeToggleBtn.addEventListener('click', () => {
			updateTheme(!toolOptions.darkTheme);
		});
	}

	// 初始化主题设置
	if (toolOptions.darkTheme !== undefined) {
		updateTheme(toolOptions.darkTheme);
	}
})()
