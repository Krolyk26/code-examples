'use strict';

define(['angular', 'environment'], function(angular) {

    angular.module('commonInfrastructure')
    .factory('ApiService', ['$q', '$http', '$rootScope', 'environment', function ($q, $http, $rootScope, environment) {

        const DEFAULT_TIMEOUT = 300000;
        const CONTENT_TYPE_JSON = 'application/json';

        $http.defaults.headers.common['Accept'] = CONTENT_TYPE_JSON;
        $http.defaults.headers.common['Content-Type'] = CONTENT_TYPE_JSON;
        $http.defaults.useXDomain = true;

        function ApiService() {
            this.baseApiUrl = environment.apiTestURL + '/';
        }

        ApiService.prototype.getBaseApiUrl = function() {
            return this.baseApiUrl;
        }


        ApiService.prototype.get = function(url, params, onSuccess, onError, additionalConfig = {}) {
            return this.send('GET', url, {
                params: params,
                onSuccess: onSuccess,
                onError: onError,
                additionalConfig: additionalConfig,
            });
        };

        ApiService.prototype.post = function(url, data, onSuccess, onError, timeout) {
            return this.send('POST', url, {
                data: data,
                onSuccess: onSuccess,
                onError: onError,
                timeout: timeout
            });
        };

        ApiService.prototype.put = function(url, data, onSuccess, onError) {
            return this.send('PUT', url, {
                data: data,
                onSuccess: onSuccess,
                onError: onError
            });
        };

        ApiService.prototype.del = function(url, data, onSuccess, onError) {
            return this.send('DELETE', url, {
                data: data,
                onSuccess: onSuccess,
                onError: onError
            });
        };

        ApiService.prototype.head = function(url, onSuccess, onError) {
            this.send('HEAD', url, {
                onSuccess: onSuccess,
                onError: onError
            });
        };


        ApiService.prototype.abortableGet = function(url, params, data) {
            var that = this;
            return createAbortableRequest(function(onSuccess, onError){
                return that.send('GET', url, {
                    params: params,
                    data: data,
                    onSuccess: onSuccess,
                    onError: onError
                });
            });
        };

        ApiService.prototype.abortablePost = function(url, params, data) {
            var that = this;
            return createAbortableRequest(function(onSuccess, onError){
                return that.send('POST', url, {
                    params: params,
                    data: data,
                    onSuccess: onSuccess,
                    onError: onError
                });
            });
        };

        ApiService.prototype.downloadFile = function (url) {
            var deferred = $q.defer();
            var config = { responseType: 'blob' };
            
            $http.get(this.baseApiUrl + url, config).then(function (resp) {
                var headers = resp.headers();
                var type = headers['content-type'];
                var disposition = headers['content-disposition'];
                var filename = 'download';
                
                if (disposition && disposition.indexOf('filename=') !== -1) {
                    filename = disposition.split('filename=')[1].split(';')[0].replace(/"/g, '');
                }

                var blob = new Blob([resp.data], { type: type });
                var objectUrl = window.URL.createObjectURL(blob);
                
                var anchor = document.createElement('a');
                anchor.style.display = 'none';
                anchor.href = objectUrl;
                anchor.download = filename;
                document.body.appendChild(anchor);
                anchor.click();
                
                window.URL.revokeObjectURL(objectUrl);
                document.body.removeChild(anchor);
                
                deferred.resolve();
            }, function (error) {
                if (error.data instanceof Blob) {
                    var reader = new FileReader();
                    reader.onload = function() {
                        try {
                            var jsonError = JSON.parse(reader.result);
                            deferred.reject(jsonError);
                        } catch (e) {
                            deferred.reject(error);
                        }
                    };
                    reader.readAsText(error.data);
                } else {
                    deferred.reject(error);
                }
            });

            return deferred.promise;
        };

        ApiService.prototype.filePost = function(url, file, onSuccess, onError, requestConfig = {}) {       
            this._handleFileUpload('POST', url, 'image', file, onSuccess, onError, requestConfig);
        };

        ApiService.prototype.postExcel = function(url, file, onSuccess, onError, requestConfig = {}) {
            this._handleFileUpload('POST', url, 'file', file, onSuccess, onError, requestConfig);
        };

        ApiService.prototype.filePostArrayBuffer = function(url, file, onSuccess, onError, requestConfig = {}) {
            requestConfig.responseType = 'arraybuffer';
            this._handleFileUpload('POST', url, 'file', file, onSuccess, onError, requestConfig);
        };


        ApiService.prototype.postForm = function(url, data, onSuccess, onError) { 
            $http({
                method: 'POST',
                url: this.baseApiUrl + url,
                data: data,
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                timeout: DEFAULT_TIMEOUT
            }).then(function(response) {
                onSuccess(response.status);
            }, function(response) {
                onError(response.status);
            });
        };

        ApiService.prototype.cachingGet = function(url, params, onSuccess, onError) {
            this.cachingSend('GET', url, {
                params: params,
                onSuccess: onSuccess,
                onError: onError
            });
        };

        ApiService.prototype.asyncGet = function(url) {
            return $http.get(this.baseApiUrl + url);
        };

        ApiService.prototype.rawGet = function(url) {
            return $http.get(this.baseApiUrl + url);
        };


        ApiService.prototype.send = function(method, url, request) {
            var canceler = $q.defer();
            var headers = _createHeaders(request);
            
            var conf = {
                method: method, 
                url: this.baseApiUrl + url,
                data: request.data,
                headers: headers,
                params: request.params,
                timeout: request.timeout ? request.timeout : canceler.promise
            };

            if (request.responseType) {
                conf.responseType = request.responseType;
            }

            canceler.promise.then(function() {
                canceler.requestCancelled = true;
            });

            const startTime = new Date().getTime();

            $http(conf).then(function successCallback(response) {
                if (response) {
                    response.config.responseTime = new Date().getTime() - startTime;    
                    if (request.onSuccess) {
                        request.onSuccess({ 
                            data: response.data, 
                            status: response.status, 
                            headers: response.headers, 
                            config: response.config 
                        });
                    }
                } else if (request.onError) {
                    request.onError({});
                }
            }, function errorCallback(response) {
                if (request.onError && !canceler.requestCancelled) {
                    request.onError({ 
                        data: response.data, 
                        status: response.status, 
                        headers: response.headers, 
                        config: response.config 
                    });
                }
            });

            return canceler;
        };

        ApiService.prototype.cachingSend = function(method, url, request) {
            $http({
                method: method, 
                url: this.baseApiUrl + url,
                data: request.data,
                params: request.params,
                cache: true,
                timeout: DEFAULT_TIMEOUT
            }).then(function(response) {
                if (request.onSuccess) { 
                    request.onSuccess({ 
                        data: response.data, 
                        status: response.status, 
                        headers: response.headers, 
                        config: response.config 
                    });
                }
            }, function(response) {
               if (request.onError) {
                    request.onError({ 
                        data: response.data, 
                        status: response.status, 
                        headers: response.headers, 
                        config: response.config 
                    });
               }
            });
        };

        ApiService.prototype._handleFileUpload = function(method, url, fileKey, file, onSuccess, onError, requestConfig) {
            var formData = new FormData();
            formData.append(fileKey, file);
            
            var headers = _createHeaders(requestConfig);
            headers['Content-Type'] = undefined; 

            var httpConfig = {
                method: method,
                url: this.baseApiUrl + url,
                data: formData,
                transformRequest: angular.identity,
                headers: headers
            };

            if (requestConfig.responseType) {
                httpConfig.responseType = requestConfig.responseType;
            }

            $http(httpConfig).then(function(response) {
                onSuccess(response.data);
            }, function(response) {
                var error = { status: response.status };
                angular.extend(error, response.data);
                onError(error);
            });
        };


        function createAbortableRequest(func) {
            var abortable = {};
            var deferred = $q.defer();
            
            var canceler = func(function(response){
                abortable.responseTime = response.config.responseTime;
                deferred.resolve(response);
            }, function(error){
                deferred.reject(error);
            });

            abortable.promise = deferred.promise;
            abortable.canceler = canceler;
            return abortable;
        }

        function _createHeaders(request) {
            const headers = {};
            if ($rootScope.authorisedAsChildCompany && 
               (!request.additionalConfig || !request.additionalConfig.disableHeaderAuthorisedAsChildCompany)) {
                headers["scope-parent-auth-as-child"] = $rootScope.authorisedAsChildCompany;
            }
            return headers;
        }

        return ApiService;
    }]);
});
